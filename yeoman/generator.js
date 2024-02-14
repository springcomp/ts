import fs, { readFileSync } from 'node:fs';
import path, { dirname, resolve as pathResolve, join as pathJoin } from 'node:path';
import os from 'node:os';
import EventEmitter from 'node:events';
import { fileURLToPath } from 'node:url';
import * as _ from 'lodash-es';
import semver from 'semver';
import { readPackageUpSync } from 'read-package-up';
import chalk from 'chalk';
import minimist from 'minimist';
import createDebug from 'debug';
import { create as createMemFsEditor } from 'mem-fs-editor';
import { requireNamespace, toNamespace } from '@yeoman/namespace';
import Storage from './util/storage.js';
import { prefillQuestions, storeAnswers } from './util/prompt-suggestion.js';
import { DESTINATION_ROOT_CHANGE_EVENT, requiredEnvironmentVersion } from './constants.js';
import { FsMixin } from './actions/fs.js';
import { HelpMixin } from './actions/help.js';
import { PackageJsonMixin } from './actions/package-json.js';
import { SpawnCommandMixin } from './actions/spawn-command.js';
import { GitMixin } from './actions/user.js';
import { TasksMixin } from './actions/lifecycle.js';
const _filename = fileURLToPath(import.meta.url);
const _dirname = dirname(_filename);
// eslint-disable-next-line @typescript-eslint/naming-convention
const EMPTY = '@@_YEOMAN_EMPTY_MARKER_@@';
// eslint-disable-next-line @typescript-eslint/naming-convention
const ENV_VER_WITH_VER_API = '2.9.0';
const packageJson = JSON.parse(readFileSync(pathJoin(_dirname, '../package.json'), 'utf8'));
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class BaseGenerator
// eslint-disable-next-line unicorn/prefer-event-target
 extends EventEmitter {
    options;
    _initOptions;
    _args;
    _options;
    _arguments;
    _prompts;
    _namespace;
    _namespaceId;
    _customPriorities;
    resolved;
    description;
    contextRoot;
    _debug;
    env;
    fs;
    log;
    _ = _;
    appname;
    args;
    /** @deprecated */
    arguments;
    _destinationRoot;
    _sourceRoot;
    generatorConfig;
    instanceConfig;
    _config;
    _packageJson;
    _globalConfig;
    // If for some reason environment adds more queues, we should use or own for stability.
    static get queues() {
        return [
            'initializing',
            'prompting',
            'configuring',
            'default',
            'writing',
            'transform',
            'conflicts',
            'install',
            'end',
        ];
    }
    _running = false;
    features;
    yoGeneratorVersion = packageJson.version;
    // eslint-disable-next-line complexity
    constructor(args, options, features) {
        super();
        const actualArgs = Array.isArray(args) ? args : [];
        const actualOptions = Array.isArray(args) ? options : args;
        const actualFeatures = Array.isArray(args) ? features : options;
        const { env, ...generatorOptions } = actualOptions;
        // Load parameters
        this._args = actualArgs;
        this.options = generatorOptions;
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        this.features = actualFeatures ?? {};
        // Initialize properties
        this._options = {};
        this._arguments = [];
        this._prompts = [];
        // Parse parameters
        this._initOptions = { ...actualOptions };
        this._namespace = actualOptions.namespace;
        this._namespaceId = toNamespace(actualOptions.namespace);
        this._customPriorities = this.features?.customPriorities;
        this.features.skipParseOptions = this.features.skipParseOptions ?? this.options.skipParseOptions;
        this.features.customPriorities = this.features.customPriorities ?? this.options.customPriorities;
        this.option('help', {
            type: Boolean,
            alias: 'h',
            description: "Print the generator's options and usage",
        });
        this.option('skip-cache', {
            type: Boolean,
            description: 'Do not remember prompt answers',
            default: false,
        });
        this.option('skip-install', {
            type: Boolean,
            description: 'Do not automatically install dependencies',
            default: false,
        });
        this.option('force-install', {
            type: Boolean,
            description: 'Fail on install dependencies error',
            default: false,
        });
        this.option('ask-answered', {
            type: Boolean,
            description: 'Show prompts for already configured options',
            default: false,
        });
        this.env = env;
        this.resolved = actualOptions.resolved;
        this.description = actualOptions.description ?? '';
        if (this.env) {
            // Determine the app root
            this.contextRoot = this.env.cwd;
            this.destinationRoot(this.options.destinationRoot ?? this.env.cwd);
            // Clear destionationRoot, _destinationRoot will take priority when composing, but not override passed options.
            delete this.options.destinationRoot;
            this.fs = createMemFsEditor(this.env.sharedFs);
        }
        // Add convenience debug object
        this._debug = createDebug(this._namespace);
        // Ensure source/destination path, can be configured from subclasses
        // Used by help()
        this.sourceRoot(path.join(path.dirname(this.resolved), 'templates'));
        if (actualOptions.help) {
            return;
        }
        if (this.features.unique && !this.features.uniqueBy) {
            let uniqueBy;
            if (this.features.unique === true || this.features.unique === 'namespace') {
                uniqueBy = this._namespace;
            }
            else if (this.features.unique === 'argument' && this._args.length === 1) {
                const namespaceId = requireNamespace(this._namespace).with({ instanceId: this._args[0] });
                uniqueBy = namespaceId.id;
            }
            else {
                throw new Error(`Error generating a uniqueBy value. Uniqueness '${this.features.unique}' not supported by '${this._namespace}'`);
            }
            this.features.uniqueBy = uniqueBy;
        }
        if (!this.env) {
            throw new Error('This generator requires an environment.');
        }
        // Ensure the environment support features this yeoman-generator version require.
        if (!this.env.adapter || !this.env.sharedFs) {
            throw new Error("Current environment doesn't provides some necessary feature this generator needs.");
        }
        // Mirror the adapter log method on the generator.
        //
        // example:
        // this.log('foo');
        // this.log.error('bar');
        this.log = this.env.adapter.log;
        this.appname = this.determineAppname();
        // Create config for the generator and instance
        if (this._namespaceId?.generator) {
            this.generatorConfig = this.config.createStorage(`:${this._namespaceId.generator}`);
            if (this._namespaceId.instanceId) {
                this.instanceConfig = this.generatorConfig.createStorage(`#${this._namespaceId.instanceId}`);
            }
        }
        this._globalConfig = this._getGlobalStorage();
        this.checkEnvironmentVersion(requiredEnvironmentVersion, this.options.skipCheckEnv ?? false);
    }
    /**
     * Configure Generator behaviours.
     *
     * @param features
     * @param features.unique - Generates a uniqueBy id for the environment
     *                                    Accepts 'namespace' or 'true' for one instance by namespace
     *                                    Accepts 'argument' for one instance by namespace and 1 argument
     *
     */
    setFeatures(features) {
        Object.assign(this.features, features);
    }
    /**
     * Specifications for Environment features.
     */
    getFeatures() {
        return this.features;
    }
    checkEnvironmentVersion(packageDependency, version, warning = false) {
        let versionToCheck;
        if (typeof version === 'boolean' || version === undefined) {
            warning = version ?? false;
            versionToCheck = packageDependency ?? ENV_VER_WITH_VER_API;
            packageDependency = 'yeoman-environment';
        }
        else {
            versionToCheck = version;
        }
        const returnError = (currentVersion) => {
            return new Error(`This generator (${this._namespace}) requires ${packageDependency} at least ${versionToCheck}, current version is ${currentVersion}, try reinstalling latest version of 'yo' or use '--ignore-version-check' option`);
        };
        if (!this.env.getVersion) {
            if (!this.options.ignoreVersionCheck && !warning) {
                throw returnError(`less than ${ENV_VER_WITH_VER_API}`);
            }
            console.warn(`It's not possible to check version with running Environment less than ${ENV_VER_WITH_VER_API}`);
            console.warn('Some features may be missing');
            if (semver.lte(versionToCheck, '2.8.1')) {
                return undefined;
            }
            return false;
        }
        const runningVersion = this.env.getVersion(packageDependency);
        if (runningVersion !== undefined && semver.lte(versionToCheck, runningVersion)) {
            return true;
        }
        // Version cannot be checked
        if (runningVersion === undefined) {
            return true;
        }
        // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
        if (this.options.ignoreVersionCheck || warning) {
            console.warn(`Current ${packageDependency} is not compatible with current generator, min required: ${versionToCheck} current version: ${runningVersion}. Some features may be missing, try updating reinstalling 'yo'.`);
            return false;
        }
        throw returnError(runningVersion);
    }
    /**
     * Convenience debug method
     *
     * @param parameters to be passed to debug
     */
    debug(formater, ...args) {
        this._debug(formater, ...args);
    }
    /**
     * Register stored config prompts and optional option alternative.
     *
     * @param questions - Inquirer question or questions.
     * @param questions.exportOption - Additional data to export this question as an option.
     * @param question.storage - Storage to store the answers.
     */
    registerConfigPrompts(questions) {
        questions = Array.isArray(questions) ? questions : [questions];
        const getOptionTypeFromInquirerType = (type) => {
            if (type === 'number') {
                return Number;
            }
            if (type === 'confirm') {
                return Boolean;
            }
            if (type === 'checkbox') {
                return Array;
            }
            return String;
        };
        for (const q of questions) {
            const question = { ...q };
            if (q.exportOption) {
                const option = typeof q.exportOption === 'boolean' ? {} : q.exportOption;
                this.option({
                    name: q.name,
                    type: getOptionTypeFromInquirerType(q.type),
                    description: q.message,
                    ...option,
                    storage: q.storage ?? this.config,
                });
            }
            this._prompts.push(question);
        }
    }
    /**
     * Prompt user to answer questions. The signature of this method is the same as {@link https://github.com/SBoudrias/Inquirer.js Inquirer.js}
     *
     * On top of the Inquirer.js API, you can provide a `{store: true}` property for
     * every question descriptor. When set to true, Yeoman will store/fetch the
     * user's answers as defaults.
     *
     * @param questions  Array of question descriptor objects. See {@link https://github.com/SBoudrias/Inquirer.js/blob/master/README.md Documentation}
     * @param questions.storage Storage object or name (generator property) to be used by the question to store/fetch the response.
     * @param storage Storage object or name (generator property) to be used by default to store/fetch responses.
     * @return prompt promise
     */
    async prompt(questions, storage) {
        const storageForQuestion = {};
        const arrayQuestions = Array.isArray(questions) ? questions : [questions];
        const getAnswerFromStorage = (question) => {
            const questionRef = question.storage ?? storage;
            const questionStorage = typeof questionRef === 'string' ? this[questionRef] : questionRef;
            if (questionStorage) {
                const { name } = question;
                storageForQuestion[name] = questionStorage;
                const value = questionStorage.getPath(name);
                if (value !== undefined) {
                    question.default = (answers) => answers[name];
                    return [name, value];
                }
            }
            return undefined;
        };
        // Shows the prompt even if the answer already exists.
        for (const question of arrayQuestions) {
            if (question.askAnswered === undefined) {
                question.askAnswered = this.options.askAnswered === true;
            }
        }
        questions = prefillQuestions(this._globalConfig, arrayQuestions);
        questions = prefillQuestions(this.config, arrayQuestions);
        const initialAnswers = Object.fromEntries(questions.map(question => getAnswerFromStorage(question)).filter(Boolean));
        const answers = await this.env.adapter.prompt(questions, initialAnswers);
        for (const [name, questionStorage] of Object.entries(storageForQuestion)) {
            const answer = answers[name] === undefined ? null : answers[name];
            questionStorage.setPath(name, answer);
        }
        if (!this.options.skipCache) {
            storeAnswers(this._globalConfig, questions, answers, false);
            if (!this.options.skipLocalCache) {
                storeAnswers(this.config, questions, answers, true);
            }
        }
        return answers;
    }
    /**
     * Adds an option to the set of generator expected options, only used to
     * generate generator usage. By default, generators get all the cli options
     * parsed by nopt as a `this.options` hash object.
     *
     * @param name - Option name
     * @param config - Option options
     * @param config.type - Either Boolean, String or Number
     * @param config.description - Description for the option
     * @param config.default - Default value
     * @param config.alias - Option name alias (example `-h` and --help`)
     * @param config.hide - Boolean whether to hide from help
     * @param config.storage - Storage to persist the option
     * @return This generator
     */
    option(name, config) {
        if (Array.isArray(name)) {
            for (const option of name) {
                this.option(option);
            }
            return;
        }
        const spec = typeof name === 'object'
            ? name
            : { hide: false, type: Boolean, description: 'Description for ' + name, ...config, name };
        const specName = spec.name;
        // Check whether boolean option is invalid (starts with no-)
        const boolOptionRegex = /^no-/;
        if (spec.type === Boolean && specName.startsWith('no-')) {
            const simpleName = specName.replace(boolOptionRegex, '');
            throw new Error([
                `Option name ${chalk.yellow(specName)} cannot start with ${chalk.red('no-')}\n`,
                `Option name prefixed by ${chalk.yellow('--no')} are parsed as implicit`,
                ` boolean. To use ${chalk.yellow('--' + specName)} as an option, use\n`,
                chalk.cyan(`  this.option('${simpleName}', {type: Boolean})`),
            ].join(''));
        }
        if (!this._options[specName]) {
            this._options[specName] = spec;
        }
        if (!this.features.skipParseOptions) {
            this.parseOptions();
        }
        const { storage } = spec;
        if (storage && this.options[specName] !== undefined) {
            const storageObject = typeof storage === 'string' ? this[storage] : storage;
            storageObject.set(specName, this.options[specName]);
        }
        return this;
    }
    /**
     * Adds an argument to the class and creates an attribute getter for it.
     *
     * Arguments are different from options in several aspects. The first one
     * is how they are parsed from the command line, arguments are retrieved
     * based on their position.
     *
     * Besides, arguments are used inside your code as a property (`this.argument`),
     * while options are all kept in a hash (`this.options`).
     *
     *
     * @param name - Argument name
     * @param config - Argument options
     * @return This generator
     */
    argument(name, config = {}) {
        // Alias default to defaults for backward compatibility.
        if ('defaults' in config) {
            config.default = config.defaults;
        }
        this._arguments.push({
            name,
            required: config.default === null || config.default === undefined,
            type: String,
            ...config,
        });
        if (!this.features.skipParseOptions) {
            this.parseOptions();
        }
        return this;
    }
    parseOptions() {
        const booleans = [];
        const strings = [];
        const alias = {};
        const defaults = {};
        for (const option of Object.values(this._options)) {
            if (option.type === Boolean) {
                booleans.push(option.name);
                if (!('default' in option) && !option.required) {
                    defaults[option.name] = EMPTY;
                }
            }
            else {
                strings.push(option.name);
            }
            if (option.alias) {
                alias[option.alias] = option.name;
            }
            // Only apply default values if we don't already have a value injected from
            // the runner
            if (option.name in this._initOptions) {
                defaults[option.name] = this._initOptions[option.name];
            }
            else if (option.alias && option.alias in this._initOptions) {
                defaults[option.name] = this._initOptions[option.alias];
            }
            else if ('default' in option) {
                defaults[option.name] = option.default;
            }
        }
        const parsedOptions = minimist(this._args, { boolean: booleans, string: strings, alias, default: defaults });
        // Parse options to the desired type
        for (const [name, option] of Object.entries(parsedOptions)) {
            // Manually set value as undefined if it should be.
            if (option === EMPTY) {
                // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
                delete parsedOptions[name];
            }
            else if (this._options[name] && option !== undefined) {
                parsedOptions[name] = this._options[name].type(option);
            }
        }
        // Parse positional arguments to valid options
        for (const [index, config] of this._arguments.entries()) {
            let value;
            if (index >= parsedOptions._.length) {
                if (config.name in this._initOptions) {
                    value = this._initOptions[config.name];
                }
                else if ('default' in config) {
                    value = config.default;
                }
                else {
                    continue;
                }
            }
            else if (config.type === Array) {
                value = parsedOptions._.slice(index, parsedOptions._.length);
            }
            else {
                value = config.type(parsedOptions._[index]);
            }
            parsedOptions[config.name] = value;
        }
        // Make the parsed options available to the instance
        Object.assign(this.options, parsedOptions);
        this.args = parsedOptions._;
        this.arguments = parsedOptions._;
        // Make sure required args are all present
        this.checkRequiredArgs();
    }
    checkRequiredArgs() {
        // If the help option was provided, we don't want to check for required
        // arguments, since we're only going to print the help message anyway.
        if (this.options.help) {
            return;
        }
        // Bail early if it's not possible to have a missing required arg
        if (this.args.length > this._arguments.length) {
            return;
        }
        for (const [position, config] of this._arguments.entries()) {
            // If the help option was not provided, check whether the argument was
            // required, and whether a value was provided.
            if (config.required && position >= this.args.length) {
                throw new Error(`Did not provide required argument ${chalk.bold(config.name)}!`);
            }
        }
    }
    /**
     * Generator config Storage.
     */
    get config() {
        if (!this._config) {
            this._config = this._getStorage();
        }
        return this._config;
    }
    /**
     * Package.json Storage resolved to `this.destinationPath('package.json')`.
     *
     * Environment watches for package.json changes at `this.env.cwd`, and triggers an package manager install if it has been committed to disk.
     * If package.json is at a different folder, like a changed generator root, propagate it to the Environment like `this.env.cwd = this.destinationPath()`.
     *
     * @example
     * this.packageJson.merge({
     *   scripts: {
     *     start: 'webpack --serve',
     *   },
     *   dependencies: {
     *     ...
     *   },
     *   peerDependencies: {
     *     ...
     *   },
     * });
     */
    get packageJson() {
        if (!this._packageJson) {
            this._packageJson = this.createStorage('package.json');
        }
        return this._packageJson;
    }
    /**
     * Runs the generator, scheduling prototype methods on a run queue. Method names
     * will determine the order each method is run. Methods without special names
     * will run in the default queue.
     *
     * Any method named `constructor` and any methods prefixed by a `_` won't be scheduled.
     *
     * @return Resolved once the process finish
     */
    async run() {
        return this.env.runGenerator(this);
    }
    /**
     * Determine the root generator name (the one who's extending Generator).
     * @return The name of the root generator
     */
    rootGeneratorName() {
        return readPackageUpSync({ cwd: this.resolved })?.packageJson?.name ?? '*';
    }
    /**
     * Determine the root generator version (the one who's extending Generator).
     * @return The version of the root generator
     */
    rootGeneratorVersion() {
        return readPackageUpSync({ cwd: this.resolved })?.packageJson?.version ?? '0.0.0';
    }
    /**
     * Return a storage instance.
     * @param storePath  The path of the json file
     * @param options storage options or the storage name
     */
    createStorage(storePath, options) {
        if (typeof options === 'string') {
            options = { name: options };
        }
        storePath = this.destinationPath(storePath);
        return new Storage(this.fs, storePath, options);
    }
    /**
     * Return a storage instance.
     * @param rootName The rootName in which is stored inside .yo-rc.json
     * @param options Storage options
     * @return Generator storage
     */
    _getStorage(rootName = this.rootGeneratorName(), options = {}) {
        if (typeof rootName === 'object') {
            options = rootName;
            rootName = this.rootGeneratorName();
        }
        return this.createStorage('.yo-rc.json', { ...options, name: rootName });
    }
    /**
     * Setup a globalConfig storage instance.
     * @return Global config storage
     */
    _getGlobalStorage() {
        // When localConfigOnly === true simulate a globalConfig at local dir
        const globalStorageDir = this.options.localConfigOnly ? this.destinationRoot() : os.homedir();
        const storePath = path.join(globalStorageDir, '.yo-rc-global.json');
        const storeName = `${this.rootGeneratorName()}:${this.rootGeneratorVersion()}`;
        return this.createStorage(storePath, { name: storeName });
    }
    /**
     * Change the generator destination root directory.
     * This path is used to find storage, when using a file system helper method (like
     * `this.write` and `this.copy`)
     * @param rootPath new destination root path
     * @return destination root path
     */
    destinationRoot(rootPath) {
        if (typeof rootPath === 'string') {
            this._destinationRoot = pathResolve(rootPath);
            if (!fs.existsSync(this._destinationRoot)) {
                fs.mkdirSync(this._destinationRoot, { recursive: true });
            }
            this.emit(DESTINATION_ROOT_CHANGE_EVENT, this._destinationRoot);
            // Reset the storage
            this._config = undefined;
            // Reset packageJson
            this._packageJson = undefined;
        }
        return this._destinationRoot || this.env.cwd;
    }
    /**
     * Get or change the generator source root directory.
     * This path is used by multiples file system methods like (`this.read` and `this.copy`)
     * @param rootPath new source root path
     */
    sourceRoot(rootPath) {
        if (typeof rootPath === 'string') {
            this._sourceRoot = pathResolve(rootPath);
        }
        return this._sourceRoot;
    }
    /**
     * Join a path to the source root.
     * @param dest - path parts
     * @return joined path
     */
    templatePath(...dest) {
        let filepath = path.join.apply(path, dest);
        if (!path.isAbsolute(filepath)) {
            filepath = path.join(this.sourceRoot(), filepath);
        }
        return filepath;
    }
    /**
     * Join a path to the destination root.
     * @param dest - path parts
     * @return joined path
     */
    destinationPath(...dest) {
        let filepath = path.join.apply(path, dest);
        if (!path.isAbsolute(filepath)) {
            filepath = path.join(this.destinationRoot(), filepath);
        }
        return filepath;
    }
    /**
     * Determines the name of the application.
     *
     * First checks for name in bower.json.
     * Then checks for name in package.json.
     * Finally defaults to the name of the current directory.
     * @return The name of the application
     */
    determineAppname() {
        const appName = this.packageJson.get('name') ?? path.basename(this.destinationRoot());
        return appName.replaceAll(/[^\w\s]+?/g, ' ');
    }
}
applyMixins(BaseGenerator, [FsMixin, HelpMixin, PackageJsonMixin, SpawnCommandMixin, GitMixin, TasksMixin]);
function applyMixins(destCtor, constructors) {
    for (const sourceCtor of constructors) {
        for (const name of Object.getOwnPropertyNames(sourceCtor.prototype)) {
            Object.defineProperty(destCtor.prototype, name, Object.getOwnPropertyDescriptor(sourceCtor.prototype, name) ?? Object.create(null));
        }
    }
}
export default BaseGenerator;

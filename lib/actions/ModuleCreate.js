'use strict';

/**
 * Action: ModuleCreate
 * - takes module and function names
 * - validates that module doesn't already exist
 * - generates function sturcture based on runtime
 * - generates module structure
 *
 * Event Properties:
 * - module:    (String) Name of your new module
 * - function:  (String) Name of your first function in your new module
 */

const SPlugin  = require('../ServerlessPlugin'),
    SError     = require('../ServerlessError'),
    SCli       = require('../utils/cli'),
    SUtils     = require('../utils'),
    BbPromise  = require('bluebird'),
    path       = require('path'),
    wrench     = require('wrench');

let fs = require('fs');
BbPromise.promisifyAll(fs);

const supportedRuntimes = {
  nodejs: {
    defaultPkgMgr: 'npm',
    validPkgMgrs:  ['npm'],
  },
};

/**
 * ModuleCreate Class
 */

class ModuleCreate extends SPlugin {

  constructor(S, config) {
    super(S, config);
    this._templatesDir   = path.join(__dirname, '..', 'templates');
    this.evt = {};
  }

  static getName() {
    return 'serverless.core.' + ModuleCreate.name;
  }

  registerActions() {
    this.S.addAction(this.moduleCreate.bind(this), {
      handler:       'moduleCreate',
      description:   `Creates scaffolding for a new serverless module.
usage: serverless module create`,
      context:       'module',
      contextAction: 'create',
      options:       [
        {
          option:      'module',
          shortcut:    'm',
          description: 'The name of your new module'
        },
        {
          option:      'function',
          shortcut:    'f',
          description: 'The name of your first function for your new module'
        },
        {
          option:      'runtime',
          shortcut:    'r',
          description: 'Optional - Runtime of your new module. Default: nodejs'
        },
        {
          option:      'nonInteractive',
          shortcut:    'ni',
          description: 'Optional - Turn off CLI interactivity if true. Default: false'
        },
      ],
    });

    return BbPromise.resolve();
  };


  /**
   * Action
   */
  
  moduleCreate(evt) {
    let _this = this;

    if(evt) {
      _this.evt = evt;
      _this.S._interactive = false;
    }
    
    // If CLI, parse options
    if (_this.S.cli) {
      _this.evt = this.S.cli.options;

      if (_this.S.cli.options.nonInteractive) {
        _this.S._interactive = false;
      }
    }

    return _this.S.validateProject()
        .bind(_this)
        .then(_this._promptModuleFunction)
        .then(_this._validateAndPrepare)
        .then(_this._createModuleSkeleton)
        .then(_this._installFunctionDependencies)
        .then(function() {
          SCli.log('Successfully created new serverless module "' + _this.evt.module + '" with its first function "' + _this.evt.function + '"');
          // Return Event
          return _this.evt;
        });
  };

  /**
   * Prompt module & function if they're missing
   */
  
  _promptModuleFunction(){
    let _this = this,
        overrides = {};

    if (!_this.S._interactive) return BbPromise.resolve();
    
    ['module', 'function'].forEach(memberVarKey => {
      overrides[memberVarKey] = _this['evt'][memberVarKey];
    });

    let prompts = {
      properties: {
        module:              {
          description: 'Enter a name for your new module: '.yellow,
          message:     'Module name is required.',
          required:    true,
        },
        function:            {
          description: 'Enter a function name for your new module: '.yellow,
          message:     'Function name is required',
          required:    true,
        },
      }
    };
    
    return _this.cliPromptInput(prompts, overrides)
        .then(function(answers) {
          _this.evt.module = answers.module;
          _this.evt.function = answers.function;
        });
  };
  
  /**
   * Validate and prepare data before creating module
   */

  _validateAndPrepare() {
    // non interactive validation
    if (!this.S._interactive) {
      if (!this.evt.module || !this.evt.function) {
        return BbPromise.reject(new SError('Missing module or/and function names'));
      }
    }
    
    // Add default runtime
    if (!this.evt.runtime) {
      this.evt.runtime = 'nodejs';
    }

    if (!supportedRuntimes[this.evt.runtime]) {
      return BbPromise.reject(new SError('Unsupported runtime ' + this.evt.runtime, SError.errorCodes.UNKNOWN));
    }

    // Sanitize module
    this.evt.module = this.evt.module.toLowerCase().trim()
        .replace(/\s/g, '-')
        .replace(/[^a-zA-Z-\d:]/g, '')
        .substring(0, 19);

    // Sanitize function
    this.evt.function = this.evt.function.toLowerCase().trim()
        .replace(/\s/g, '-')
        .replace(/[^a-zA-Z-\d:]/g, '')
        .substring(0, 19);
    
    // If module already exists, throw error
    let modulePath = path.join(this.S._projectRootPath, 'back', 'modules', this.evt.module);
    if (SUtils.dirExistsSync(modulePath)) {
      return BbPromise.reject(new SError(
          'Module ' + this.evt.module + ' already exists',
          SError.errorCodes.INVALID_PROJECT_JAWS
      ));
    }

    return BbPromise.resolve();
  };

  /**
   * Create Module Skeleton
   */

  _createModuleSkeleton() {

    let _this                = this,
        writeDeferred        = [],
        eventJson            = {},
        functionName         = _this.evt.module.charAt(0).toUpperCase() + _this.evt.module.slice(1) + _this.evt.function.charAt(0).toUpperCase() + _this.evt.function.slice(1),
        moduleJsonTemplate   = _this._generateModuleJson(),
        functionJsonTemplate = _this._generateFunctionJson(),
        packageJsonTemplate  = SUtils.readAndParseJsonSync(path.join(_this._templatesDir, 'nodejs', 'package.json')),
        handlerJs            = fs.readFileSync(path.join(this._templatesDir, 'nodejs', 'handler.js')),
        libJs                = fs.readFileSync(path.join(this._templatesDir, 'nodejs', 'index.js'));

    // Save Paths
    _this.evt.modulePath     = path.join(this.S._projectRootPath, 'back', 'modules', _this.evt.module);
    _this.evt.functionPath   = path.join(_this.evt.modulePath, _this.evt.function);
        
    // Prep package.json
    packageJsonTemplate.name         = _this.evt.module;
    packageJsonTemplate.description  = 'Dependencies for a Serverless Module written in Node.js';

    // Write base module structure
    writeDeferred.push(
      fs.mkdirSync(_this.evt.modulePath),
      fs.mkdirSync(path.join(_this.evt.modulePath, 'lib')),
      fs.mkdirSync(path.join(_this.evt.modulePath, 'package')),
      SUtils.writeFile(path.join(_this.evt.modulePath, 'package.json'), JSON.stringify(packageJsonTemplate, null, 2)),
      SUtils.writeFile(path.join(_this.evt.modulePath, 's-module.json'), JSON.stringify(moduleJsonTemplate, null, 2))
    );

    eventJson[functionName] = {};
    // Write module/function structure
    writeDeferred.push(
        fs.mkdirSync(_this.evt.functionPath),
        SUtils.writeFile(path.join(_this.evt.modulePath, 'lib', 'index.js'), libJs),
        SUtils.writeFile(path.join(_this.evt.functionPath, 'handler.js'), handlerJs),
        SUtils.writeFile(path.join(_this.evt.functionPath, 'event.json'), JSON.stringify(eventJson, null, 2)),
        SUtils.writeFile(path.join(_this.evt.functionPath, 's-function.json'), JSON.stringify(functionJsonTemplate, null, 2))
    ); 

    return BbPromise.all(writeDeferred);
  };

  /*
  * Generate s-module.json template (private)
  */
  
  _generateModuleJson() {

    let _this = this;
    let moduleJsonTemplate  = SUtils.readAndParseJsonSync(path.join(this._templatesDir, 's-module.json'));
    moduleJsonTemplate.name = _this.evt.module;

    // Add runtime
    switch (_this.evt.runtime) {
      case 'nodejs':
        moduleJsonTemplate.runtime = 'nodejs';
        break;
      default:
        return BbPromise.reject(new SError('Unsupported runtime ' + this.evt.runtime, SError.errorCodes.UNKNOWN));
        break;
    }

    // Return
    return moduleJsonTemplate;
  };

  /*
  * Generate s-function.json template (private)
  */

  _generateFunctionJson() {

    let _this = this;
    let functionJsonTemplate = SUtils.readAndParseJsonSync(path.join(this._templatesDir, 's-function.json'));

    // Add Function Name
    let functionName = _this.evt.module.charAt(0).toUpperCase() + _this.evt.module.slice(1) + _this.evt.function.charAt(0).toUpperCase() + _this.evt.function.slice(1);
    functionJsonTemplate.functions[functionName] = functionJsonTemplate.functions.functionTemplate;
    delete functionJsonTemplate.functions.functionTemplate;

    // Add Function Handler
    functionJsonTemplate.functions[functionName].handler = path.join('modules', _this.evt.module, _this.evt.function, 'handler.handler');

    // Add Function Endpoints
    functionJsonTemplate.functions[functionName].endpoints[_this.evt.module + '/' + _this.evt.function] = functionJsonTemplate.functions[functionName].endpoints.endpointTemplate;
    delete functionJsonTemplate.functions[functionName].endpoints.endpointTemplate;

    // Return
    return functionJsonTemplate;
  };

  _installFunctionDependencies() {
    SCli.log('Installing "serverless-helpers" for this module via NPM...');
    SUtils.npmInstall(this.evt.modulePath);
    return BbPromise.resolve();
  }
}

module.exports = ModuleCreate;

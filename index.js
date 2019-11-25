#!/usr/bin/env node
const fs = require('fs');
const path = require('path'); // eslint-disable-line
const yargs = require('yargs');
const ts = require('typescript');
const requireFromString = require('require-from-string');

const Util = require('./src/util.js');
const FuncTestGen = require('./src/func-test-gen.js');

const ComponentTestGen = require('./src/for-component/component-test-gen.js');
const DirectiveTestGen = require('./src/for-directive/directive-test-gen.js');
const InjectableTestGen = require('./src/for-injectable/injectable-test-gen.js');
const PipeTestGen = require('./src/for-pipe/pipe-test-gen.js');
const ClassTestGen = require('./src/for-class/class-test-gen.js');

const argv = yargs.usage('Usage: $0 <tsFile> [options]')
  .options({
    's': { alias: 'spec', describe: 'write the spec file along with source file', type: 'boolean' },
    'f': { alias: 'force', describe: 'Do not ask question when overwrite spec file', type: 'boolean' },
    'm': { alias: 'method', describe: 'Show code only for this method', type: 'string' },
    'v': { alias: 'verbose', describe: 'log verbose debug messages', type: 'boolean' }
  })
  .example('$0 my.component.ts', 'generate Angular unit test for my.component.ts')
  .help('h')
  .argv;

Util.DEBUG = argv.verbose;
const tsFile = argv._[0].replace(/\.spec\.ts$/, '.ts');
// const writeToSpec = argv.spec;
if (!(tsFile && fs.existsSync(tsFile))) {
  console.error('Error. invalid typescript file. e.g., Usage $0 <tsFile> [options]');
  process.exit(1);
}

function getFuncMockData (Klass, funcName, props) {
  const funcTestGen = new FuncTestGen(Klass, funcName);
  const funcMockData = {
    props,
    params: funcTestGen.getInitialParameters(),
    map: {},
    globals: {}
  };
  funcTestGen.getExpressionStatements().forEach((expr, ndx) => {
    const code = funcTestGen.classCode.substring(expr.start, expr.end);
    Util.DEBUG && console.log('  *** EXPRESSION ***', ndx, code.replace(/\n+/g, '').replace(/\s+/g, ' '));
    funcTestGen.setMockData(expr, funcMockData);
  });

  return funcMockData;
}

function getTestGenerator (tsPath) {
  const typescript = fs.readFileSync(path.resolve(tsPath), 'utf8');
  const angularType = Util.getAngularType(typescript).toLowerCase();
  const testGenerator = /* eslint-disable */
    angularType === 'component' ? new ComponentTestGen(tsPath) :
    angularType === 'directive' ? new DirectiveTestGen(tsPath) :
    angularType === 'service' ? new InjectableTestGen(tsPath) :
    angularType === 'pipe' ? new PipeTestGen(tsPath) :
    new ClassTestGen(tsPath); /* eslint-enable */
  return testGenerator;
}

function getFuncTest(Klass, func, angularType) {
  Util.DEBUG &&
    console.log('\x1b[36m%s\x1b[0m', `\nPROCESSING #${func.name}`);

  const type = func.constructor.name;
  const funcMockData = getFuncMockData(Klass, func.name, {});
  const funcMockJS = Util.getFuncMockJS(funcMockData, angularType);
  const funcParamJS = Util.getFuncParamJS(funcMockData);
  const assertRE = /(.*?)\s*=\s*jest\.fn\(.*/;
  const funcAssertJS = funcMockJS
    .filter(el => el.match(assertRE))
    .map(el => {
      el = el.replace(/\n/g,' ');
      return el.replace(assertRE, (_, m1) => `expect(${m1}).toHaveBeenCalled()`);
    });
  const jsToRun = 
    type === 'SetterDeclaration' ? `${angularType}.${func.name} = ${funcParamJS}`: 
    type === 'GetterDeclaration' ? `const ${func.name} = ${angularType}.${func.name}` : 
    `${angularType}.${func.name}(${funcParamJS})`;
  const itBlockName = type === 'MethodDeclaration' ? 
    `should run #${func.name}()` : `should run ${type} #${func.name}`;
  return `
    it('${itBlockName}', async () => {
      ${funcMockJS.join(';\n')}${funcMockJS.length ? ';' : ''}
      ${jsToRun};
      ${funcAssertJS.join(';\n')}${funcAssertJS.length ? ';' : ''}
    });
    `;
}

async function run (tsFile) {
  try {
    const testGenerator = getTestGenerator(tsFile);
    const { klass, typescript, ejsData } = await testGenerator.getData();
    const angularType = Util.getAngularType(typescript).toLowerCase();
    ejsData.ctorParamJs;
    ejsData.providerMocks;
    ejsData.accessorTests = {};
    ejsData.functionTests = {};

    const result = ts.transpileModule(typescript, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        experimentalDecorators: true,
        removeComments: true,
        target: ts.ScriptTarget.ES2015
      }
    });

    // replace invalid require statements
    const replacedOutputText = result.outputText
      .replace(/require\("html-custom-element"\)/gm, '{}')  //TODO configurable
      .replace(/^\S+\.define\(.*\);/gm, '')  // TODO configurable
      .replace(/require\("\.(.*)"\)/gm, '{}') // replace require statement to a variable, {}
      .replace(/super\(.*\);/gm, '') // remove inheritance code
      .replace(/super\./gm, 'this.') // change inheritance call to this call
      .replace(/\s+extends\s\S+ {/gm, ' extends Object {') // rchange inheritance to an Object
    const modjule = requireFromString(replacedOutputText);
    const Klass = modjule[ejsData.className];
    Util.DEBUG &&
      console.warn('\x1b[36m%s\x1b[0m', `PROCESSING ${klass.ctor && klass.ctor.name} constructor`);
    const ctorMockData = getFuncMockData(Klass, 'constructor', {});

    const ctorParamJs = Util.getFuncParamJS(ctorMockData);
    ejsData.ctorParamJs = ctorParamJs;
    ejsData.providerMocks = testGenerator.getProviderMocks(klass, ctorMockData.params);
    for (var key in ejsData.providerMocks) {
      ejsData.providerMocks[key] = Util.indent(ejsData.providerMocks[key]).replace(/\{\s+\}/gm, '{}');
    }

    klass.accessors.forEach(accessor => {
      ejsData.accessorTests[accessor.name] =
        Util.indent(getFuncTest(Klass, accessor, angularType), '  ');
    });

    klass.methods.forEach(method => {
      ejsData.functionTests[method.name] =
        Util.indent(getFuncTest(Klass, method, angularType), '  ');
    });

    const generated = testGenerator.getGenerated(ejsData, argv);
    testGenerator.writeGenerated(generated, argv);
  } catch (e) {
    console.error(tsFile);
    console.error(e);
    process.exit(1);
  }
}

run(tsFile);

import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
const root=path.resolve('packages/plugin-sdk');
const program=ts.createProgram(fs.readdirSync(root).filter(name=>name.endsWith('.ts')).map(name=>path.join(root,name)),{
  target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,
  declaration:true,skipLibCheck:true,strict:true,outDir:path.join(root,'dist'),
});
const diagnostics=ts.getPreEmitDiagnostics(program);
if(diagnostics.length){console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCurrentDirectory:()=>process.cwd(),getCanonicalFileName:file=>file,getNewLine:()=> '\n'}));process.exit(1);}
program.emit();

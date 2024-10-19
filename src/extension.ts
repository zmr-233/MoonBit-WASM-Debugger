import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as sourcemap from 'source-map';

let Top: any = {};
let BK: any = {};
let SP: any = {};
let ERR: any = {};
let diagCol: vscode.DiagnosticCollection;

export function activate(context: vscode.ExtensionContext) {
  // console.log('Extension activated');

  diagCol = vscode.languages.createDiagnosticCollection('mbtmap');
  context.subscriptions.push(diagCol);

  const disposable = vscode.tasks.onDidEndTaskProcess(async (event) => {
    const task = event.execution.task;
    // console.log('Task ended:', task.name);

    if (task.name === 'moon test' || task.name === 'moon run') {
      try {
        // console.log('Processing task:', task.name);
        await vscode.commands.executeCommand('workbench.action.terminal.copyLastCommandOutput');
        Top.content = await vscode.env.clipboard.readText();
        // console.log('Clipboard content:', Top.content);

        if (!Top.content.includes('wasm-function')) {
          // console.log('Content does not contain "wasm-function", skipping');
          return;
        }

        if (!vscode.workspace.workspaceFolders) {
          vscode.window.showErrorMessage('Workspace folder not found. Please submit an issue at github.com/zmr-233/MoonBit-WASM-Debugger.');
          return;
        }

        const workspaceFolder = vscode.workspace.workspaceFolders[0].uri.fsPath;
        // console.log('Workspace path:', workspaceFolder);

        const moonModPath = path.join(workspaceFolder, 'moon.mod.json');
        // console.log('moon.mod.json path:', moonModPath);

        if (!fs.existsSync(moonModPath)) {
          vscode.window.showErrorMessage('moon.mod.json not found. Please submit an issue at github.com/zmr-233/MoonBit-WASM-Debugger.');
          return;
        }

        const moonModContent = fs.readFileSync(moonModPath, 'utf8');
        const moonMod = JSON.parse(moonModContent);
        Top.name = moonMod.name;
        Top.source = path.join(workspaceFolder, moonMod.source);
        // console.log('Project name:', Top.name, 'Source path:', Top.source);

        Top.command = task.definition.id.split(',')[1];
        // console.log('Task command:', Top.command);

        let success = false;
        if (task.name === 'moon run') {
          // console.log('Handling moon run task');
          success = await handleMoonRunTask(context, task, workspaceFolder);
        } else if (task.name === 'moon test') {
          // console.log('Handling moon test task');
          success = await handleMoonTestTask(context, task, workspaceFolder);
        }
        if (!success) { return; }

        if (!BK.map_file) {
          vscode.window.showErrorMessage('Source map file not found. Please submit an issue at github.com/zmr-233/MoonBit-WASM-Debugger.');
          return;
        }

        // console.log('Parsing source-map');
        ERR.file_list = await runSourcemap(Top.content, BK.map_file);
        // console.log('Parsed file list:', ERR.file_list);

        // console.log('Adding paths to error files');
        ERR.prefix_file_list = handleFileList(ERR.file_list, Top.source);
        // console.log('Prefixed error file list:', ERR.prefix_file_list);

        // console.log('Generating VSCode problem output');
        errorOutput(ERR.prefix_file_list);
        // console.log('VSCode problem output completed');

      } catch (error: any) {
        // console.error('Failed to get task output:', error);
        vscode.window.showErrorMessage(`Failed to get task output: ${error.message}. Please submit an issue at github.com/zmr-233/MoonBit-WASM-Debugger.`);
      }
    }
  });

  context.subscriptions.push(disposable);

  const clearErrorsCommand = vscode.commands.registerCommand('mbtmap.clearErrors', () => {
    diagCol.clear();
    // console.log('Cleared error messages');
  });
  context.subscriptions.push(clearErrorsCommand);
}

async function handleMoonRunTask(context: vscode.ExtensionContext, task: vscode.Task, workspaceFolder: string) {
  // console.log('Processing moon run task');
  const args = Top.command.split(' ');
  BK.backend_type = args[args.indexOf('--target') + 1];
  // console.log('Backend type:', BK.backend_type);

  // Find main file path (assumed to be the last non-option argument)
  const nonOptionArgs = args.filter(arg => !arg.startsWith('-') && !arg.startsWith('--'));
  const mainFileArgs = nonOptionArgs.filter(arg => arg !== 'moon' && arg !== 'run');
  const mainFileArg = mainFileArgs[mainFileArgs.length - 1];
  // console.log('Main file argument:', mainFileArg);

  // Compute the full path of the main file
  const mainFilePath = path.isAbsolute(mainFileArg) ? mainFileArg : path.join(workspaceFolder, mainFileArg);
  // console.log('Main file full path:', mainFilePath);

  // Compute Top.folder by subtracting Top.source
  if (mainFilePath.startsWith(Top.source)) {
    Top.folder = path.relative(Top.source, mainFilePath);
  } else {
    Top.folder = path.relative(path.join(workspaceFolder, Top.source), mainFilePath);
  }
  // console.log('Source folder (Top.folder):', Top.folder);
  // console.log('args:', args);

  // Check for -g or --debug option
  if (!args.includes('-g') && !args.includes('--debug')) {
    // console.log('Adding --debug option and re-executing task');
    const newCommand = `${Top.command} --debug`;
    // console.log('New command:', newCommand);

    const newTask = new vscode.Task(
      task.definition,
      task.scope ?? vscode.TaskScope.Workspace,
      task.name,
      task.source,
      new vscode.ShellExecution(newCommand)
    );
    vscode.tasks.executeTask(newTask);
    return false;
  }

  BK.target_folder = path.join(workspaceFolder, 'target', BK.backend_type, 'debug', 'build', Top.folder);
  // console.log('Target folder:', BK.target_folder);

  const wasmFiles = fs.readdirSync(BK.target_folder).filter((file) => file.endsWith('.wasm'));
  if (wasmFiles.length !== 1) {
    vscode.window.showErrorMessage('Unique wasm file not found. Please submit an issue at github.com/zmr-233/MoonBit-WASM-Debugger.');
    return false;
  }

  Top.main_name = path.parse(wasmFiles[0]).name;
  // console.log('Main wasm file name:', Top.main_name);

  BK.map_file = path.join(BK.target_folder, Top.main_name) + '.wasm.map';
  // console.log('Source map file path:', BK.map_file);

  return true;
}

async function handleMoonTestTask(context: vscode.ExtensionContext, task: vscode.Task, workspaceFolder: string) {
  // console.log('Processing moon test task');
  const args = Top.command.split(' ');
  BK.backend_type = args[args.indexOf('--target') + 1];
  // console.log('Backend type:', BK.backend_type);

  const pPath = args[args.indexOf('-p') + 1];
  const pFullPath = path.isAbsolute(pPath) ? pPath : path.join(workspaceFolder, pPath);
  // console.log('Parameter -p full path:', pFullPath);

  // Compute Top.folder by subtracting Top.name
  if (pFullPath.startsWith(Top.name)) {
    Top.folder = path.relative(Top.name, pFullPath);
  } else {
    Top.folder = path.relative(path.join(workspaceFolder, Top.name), pFullPath);
  }
  // console.log('Source folder (Top.folder):', Top.folder);

  // Check for -g or --debug option
  if (!args.includes('-g') && !args.includes('--debug')) {
    // console.log('Adding --debug option and re-executing task');
    const newCommand = `${Top.command} --debug`;
    // console.log('New command:', newCommand);

    const newTask = new vscode.Task(
      task.definition,
      task.scope ?? vscode.TaskScope.Workspace,
      task.name,
      task.source,
      new vscode.ShellExecution(newCommand)
    );
    vscode.tasks.executeTask(newTask);
    return false;
  }

  if (args.includes('-f')) {
    const fileArg = args[args.indexOf('-f') + 1];
    SP.black_or_internal = fileArg.endsWith('_test.mbt') ? 'blackbox_test' : 'internal_test';
    // console.log('Test type:', SP.black_or_internal);
  }

  BK.target_folder = path.join(workspaceFolder, 'target', BK.backend_type, 'debug', 'test', Top.folder);
  // console.log('Target folder:', BK.target_folder);

  Top.main_name = `${Top.folder}.${SP.black_or_internal}`;
  // console.log('Main file name:', Top.main_name);

  BK.map_file = path.join(BK.target_folder, Top.main_name) + '.wasm.map';
  // console.log('Source map file path:', BK.map_file);

  return true;
}

async function runSourcemap(content: string, mapFile: string): Promise<Array<any>> {
  // console.log('Reading source map file:', mapFile);
  const mapData = fs.readFileSync(mapFile, 'utf8');
  const smc = await new sourcemap.SourceMapConsumer(mapData);

  // Preprocess content to remove line breaks within tokens
  content = content.replace(/([^\s])\n([^\s])/g, '$1$2');

  // Updated regex to handle the pattern, accounting for possible extra whitespace
  const regex = /at\s+(.+?)\s+\(wasm:\/\/.*?:wasm-function\[\d+\]:(0x[0-9a-fA-F]+)\)/g;
  let match;
  const fileList = [];
  const cwd = './';

  while ((match = regex.exec(content)) !== null) {
    const message = match[1].trim();
    const addr = match[2];
    // console.log('Matched address:', addr);

    const pos = smc.originalPositionFor({ line: 1, column: parseInt(addr, 16) });
    // console.log('Source position:', pos);

    if (pos.source) {
      let sourcePath = pos.source;
      sourcePath = path.isAbsolute(sourcePath) ? path.relative(cwd, sourcePath) : sourcePath;
      // console.log('Source path:', sourcePath);

      fileList.push({
        file: sourcePath,
        line: pos.line,
        column: pos.column,
        name: pos.name || '',
        message: message,
      });
    } else {
      fileList.push({
        file: '<unknown>',
        line: 0,
        column: 0,
        name: '',
        message: 'Unresolvable address',
      });
    }
  }

  smc.destroy();
  return fileList;
}

function handleFileList(fileList: Array<any>, source: string): Array<any> {
  // console.log('Processing file list:', fileList);
  return fileList.map((error) => {
    if (error.file && error.file !== '<unknown>') {
      // console.log('Processed file path:', error.file);
    }
    return error;
  });
}

interface ErrorItem {
  file: string;
  line: number;
  column: number;
  name: string;
  message: string;
}

function errorOutput(prefixFileList: ErrorItem[]) {
  // console.log('Generating VSCode problem output prefixFileList:', prefixFileList);

  diagCol.clear();
  const diagnosticsMap = new Map<string, vscode.Diagnostic[]>();

  // Define files to exclude
  const excludedFiles = new Set([
    '<unknown>',
    '__generated_driver_for_blackbox_test.mbt',
    '__generated_driver_for_internal_test.mbt'
  ]);

  let errorCounter = 1;

  prefixFileList.forEach((error) => {
    try {
      const fileName = path.basename(error.file);

      // Skip excluded files
      if (excludedFiles.has(error.file) || excludedFiles.has(fileName)) {
        // console.log(`Skipping excluded file: ${error.file}`);
        return;
      }

      const filePath = path.resolve(error.file);
      const fileUri = vscode.Uri.file(filePath);

      const range = new vscode.Range(
        new vscode.Position((error.line || 1) - 1, (error.column || 1) - 1),
        new vscode.Position((error.line || 1) - 1, Number.MAX_SAFE_INTEGER)
      );

      const diagnosticMessage = `WASM ErrStack #${errorCounter}: ${error.message}`;
      const diagnostic = new vscode.Diagnostic(range, diagnosticMessage, vscode.DiagnosticSeverity.Error);

      const uriString = fileUri.toString();
      if (!diagnosticsMap.has(uriString)) {
        diagnosticsMap.set(uriString, []);
      }
      diagnosticsMap.get(uriString)!.push(diagnostic);
      errorCounter++;
    } catch (err) {
      // console.warn('Skipping unresolvable file:', error.file, err);
    }
  });

  diagnosticsMap.forEach((diagnostics, uriString) => {
    const fileUri = vscode.Uri.parse(uriString);
    diagCol.set(fileUri, diagnostics);
  });
}
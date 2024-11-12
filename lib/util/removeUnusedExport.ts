import ts from 'typescript';
import { FileService } from './FileService.js';
import { applyTextChanges } from './applyTextChanges.js';
import {
  applyCodeFix,
  fixIdDelete,
  fixIdDeleteImports,
} from './applyCodeFix.js';
import { EditTracker } from './EditTracker.js';
import { Vertexes } from './DependencyGraph.js';
import { collectImports } from './collectImports.js';
import { MemoryFileService } from './MemoryFileService.js';
import { TaskManager } from './TaskManager.js';
import { WorkerPool } from './WorkerPool.js';
import { findFileUsage } from './findFileUsage.js';
import { createProgram } from './createProgram.js';
import { parseFile } from './parseFile.js';

const IGNORE_COMMENT = 'ts-remove-unused-skip';

const stripExportKeyword = (syntaxList: string) => {
  const file = ts.createSourceFile(
    'tmp.ts',
    `${syntaxList} function f() {}`,
    ts.ScriptTarget.Latest,
  );

  const transformer: ts.TransformerFactory<ts.SourceFile> =
    (context: ts.TransformationContext) => (rootNode: ts.SourceFile) => {
      const visitor = (node: ts.Node): ts.Node | undefined => {
        if (ts.isFunctionDeclaration(node)) {
          return ts.factory.createFunctionDeclaration(
            node.modifiers?.filter(
              (v) =>
                v.kind !== ts.SyntaxKind.ExportKeyword &&
                v.kind !== ts.SyntaxKind.DefaultKeyword,
            ),
            node.asteriskToken,
            node.name,
            node.typeParameters,
            node.parameters,
            node.type,
            node.body,
          );
        }
        return ts.visitEachChild(node, visitor, context);
      };

      return ts.visitEachChild(rootNode, visitor, context);
    };

  const result = ts.transform(file, [transformer]).transformed[0];
  const printer = ts.createPrinter();
  const code = result ? printer.printFile(result).trim() : '';
  const pos = code.indexOf('function');
  return code.slice(0, pos);
};

const disabledEditTracker: EditTracker = {
  start: () => {},
  end: () => {},
  delete: () => {},
  removeExport: () => {},
};

const createLanguageService = ({
  options,
  projectRoot,
  fileService,
}: {
  options: ts.CompilerOptions;
  projectRoot: string;
  fileService: FileService;
}) => {
  const languageService = ts.createLanguageService({
    getCompilationSettings() {
      return options;
    },
    getScriptFileNames() {
      return fileService.getFileNames();
    },
    getScriptVersion(fileName) {
      return fileService.getVersion(fileName);
    },
    getScriptSnapshot(fileName) {
      return ts.ScriptSnapshot.fromString(fileService.get(fileName));
    },
    getCurrentDirectory() {
      return projectRoot;
    },
    getDefaultLibFileName(o) {
      return ts.getDefaultLibFileName(o);
    },
    fileExists(name) {
      return fileService.exists(name);
    },
    readFile(name) {
      return fileService.get(name);
    },
  });

  return languageService;
};

const updateExportDeclaration = (code: string, unused: string[]) => {
  const tmpFile = ts.createSourceFile('tmp.ts', code, ts.ScriptTarget.Latest);

  const transformer: ts.TransformerFactory<ts.SourceFile> =
    (context: ts.TransformationContext) => (rootNode: ts.SourceFile) => {
      const visitor = (node: ts.Node): ts.Node | undefined => {
        if (
          ts.isExportSpecifier(node) &&
          unused.includes(node.getText(tmpFile))
        ) {
          return undefined;
        }
        return ts.visitEachChild(node, visitor, context);
      };

      return ts.visitEachChild(rootNode, visitor, context);
    };

  const result = ts.transform(tmpFile, [transformer]).transformed[0];

  const printer = ts.createPrinter();

  return result ? printer.printFile(result).trim() : '';
};

// for use in worker
export const processFile = ({
  targetFile,
  files,
  vertexes,
  deleteUnusedFile,
  enableCodeFix,
  options,
  projectRoot,
}: {
  targetFile: string;
  vertexes: Vertexes;
  files: Map<string, string>;
  deleteUnusedFile: boolean;
  enableCodeFix: boolean;
  options: ts.CompilerOptions;
  projectRoot: string;
}) => {
  const usage = findFileUsage({
    targetFile,
    vertexes,
    files,
    options,
  });

  if (usage.has('*')) {
    return {
      operation: 'edit' as const,
      content: files.get(targetFile) || '',
      removedExports: [],
    };
  }

  const { exports } = parseFile({
    file: targetFile,
    content: files.get(targetFile) || '',
    options,
    destFiles: vertexes.get(targetFile)?.to || new Set([]),
  });

  if (
    usage.size === 0 &&
    deleteUnusedFile &&
    !exports.some((v) => 'skip' in v && v.skip)
  ) {
    return {
      operation: 'delete' as const,
    };
  }

  const changes: ts.TextChange[] = [];
  const logs: {
    fileName: string;
    position: number;
    code: string;
  }[] = [];

  exports.forEach((item) => {
    switch (item.kind) {
      case ts.SyntaxKind.VariableStatement: {
        if (item.skip || item.name.every((it) => usage.has(it))) {
          break;
        }

        changes.push({
          newText: '',
          span: item.change.span,
        });
        logs.push({
          fileName: targetFile,
          position: item.start,
          // todo: handle variable statement with multiple declarations properly
          code: item.name.join(', '),
        });

        break;
      }
      case ts.SyntaxKind.FunctionDeclaration: {
        if (item.skip || usage.has(item.name)) {
          break;
        }

        changes.push({
          newText: item.change.isUnnamedDefaultExport
            ? ''
            : stripExportKeyword(item.change.code),
          span: item.change.span,
        });
        logs.push({
          fileName: targetFile,
          position: item.start,
          // todo: we may want to handle `export default function () {}` properly
          code: item.name,
        });

        break;
      }
      case ts.SyntaxKind.InterfaceDeclaration: {
        if (item.skip || usage.has(item.name)) {
          break;
        }

        changes.push({
          newText: '',
          span: item.change.span,
        });
        logs.push({
          fileName: targetFile,
          position: item.start,
          code: item.name,
        });

        break;
      }
      case ts.SyntaxKind.TypeAliasDeclaration: {
        if (item.skip || usage.has(item.name)) {
          break;
        }

        changes.push({
          newText: '',
          span: item.change.span,
        });
        logs.push({
          fileName: targetFile,
          position: item.start,
          code: item.name,
        });

        break;
      }
      case ts.SyntaxKind.ExportAssignment: {
        if (item.skip || usage.has('default')) {
          break;
        }

        changes.push({
          newText: '',
          span: item.change.span,
        });
        logs.push({
          fileName: targetFile,
          position: item.start,
          code: 'default',
        });

        break;
      }
      case ts.SyntaxKind.ExportDeclaration: {
        switch (item.type) {
          case 'named': {
            if (item.skip || item.name.every((it) => usage.has(it))) {
              break;
            }

            const unused = item.name.filter((it) => !usage.has(it));
            const count = item.name.length - unused.length;

            changes.push({
              newText:
                count > 0
                  ? updateExportDeclaration(item.change.code, unused)
                  : '',
              span: item.change.span,
            });

            logs.push(
              ...unused.map((it) => ({
                fileName: targetFile,
                position: item.start,
                // todo: we may want to log as `export { ${it} } from './foo';` if it's a reexport
                code: it,
              })),
            );

            break;
          }
          case 'namespace': {
            break;
          }
          case 'whole': {
            break;
          }
          default: {
            throw new Error(`unexpected: ${item satisfies never}`);
          }
        }
        break;
      }
      case ts.SyntaxKind.ClassDeclaration: {
        if (item.skip || usage.has(item.name)) {
          break;
        }

        changes.push({
          newText: '',
          span: item.change.span,
        });
        logs.push({
          fileName: targetFile,
          position: item.start,
          // todo: we may want to handle `export default class {}` properly
          code: item.name,
        });

        break;
      }
      default: {
        throw new Error(`unexpected: ${item satisfies never}`);
      }
    }
  });

  if (changes.length === 0) {
    const result = {
      operation: 'edit' as const,
      content: files.get(targetFile) || '',
      removedExports: logs,
    };

    return result;
  }

  let content = applyTextChanges(files.get(targetFile) || '', changes);
  const fileService = new MemoryFileService();
  fileService.set(targetFile, content);

  if (enableCodeFix && changes.length > 0) {
    const languageService = createLanguageService({
      options,
      projectRoot,
      fileService,
    });

    while (true) {
      fileService.set(targetFile, content);

      const result = applyCodeFix({
        fixId: fixIdDelete,
        fileName: targetFile,
        languageService,
      });

      if (result === content) {
        break;
      }

      content = result;
    }

    fileService.set(targetFile, content);

    content = applyCodeFix({
      fixId: fixIdDeleteImports,
      fileName: targetFile,
      languageService,
    });
  }

  fileService.set(targetFile, content);

  const result = {
    operation: 'edit' as const,
    content: fileService.get(targetFile),
    removedExports: logs,
  };

  return result;
};

const removeWholeExportSpecifier = (
  content: string,
  specifier: string,
  target?: ts.ScriptTarget,
) => {
  const sourceFile = ts.createSourceFile(
    'tmp.ts',
    content,
    target ?? ts.ScriptTarget.Latest,
  );

  const result: {
    textChange: ts.TextChange;
    info: { position: number; code: string };
  }[] = [];

  const visit = (node: ts.Node) => {
    if (result.length > 0) {
      return;
    }

    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      !node.exportClause &&
      node.moduleSpecifier.text === specifier
    ) {
      result.push({
        textChange: {
          newText: '',
          span: {
            start: node.getFullStart(),
            length: node.getFullWidth(),
          },
        },
        info: {
          position: node.getStart(sourceFile),
          code: node.getText(sourceFile),
        },
      });
    }
  };

  sourceFile.forEachChild(visit);

  if (!result[0]) {
    return null;
  }

  return {
    info: result[0].info,
    content: applyTextChanges(content, [result[0].textChange]),
  };
};

export const removeUnusedExport = async ({
  entrypoints,
  fileService,
  deleteUnusedFile = false,
  enableCodeFix = false,
  editTracker = disabledEditTracker,
  options = {},
  projectRoot = '.',
  pool,
  recursive,
}: {
  entrypoints: string[];
  fileService: FileService;
  enableCodeFix?: boolean;
  deleteUnusedFile?: boolean;
  editTracker?: EditTracker;
  options?: ts.CompilerOptions;
  projectRoot?: string;
  recursive: boolean;
  pool?: WorkerPool<typeof processFile>;
}) => {
  const program = createProgram({ fileService, options, projectRoot });

  const dependencyGraph = collectImports({
    fileService,
    program,
    entrypoints,
  });

  let filesOutsideOfGraphHasSkipComment = false;

  const initialFiles: { file: string; depth: number }[] = [];

  for (const file of fileService.getFileNames()) {
    if (entrypoints.includes(file)) {
      continue;
    }

    const vertex = dependencyGraph.vertexes.get(file);

    if (vertex && vertex.data.depth < Infinity) {
      initialFiles.push({ file, depth: vertex.data.depth });
      continue;
    }

    if (fileService.get(file).includes(IGNORE_COMMENT)) {
      filesOutsideOfGraphHasSkipComment = true;
    }

    if (
      deleteUnusedFile &&
      !filesOutsideOfGraphHasSkipComment &&
      !entrypoints.includes(file)
    ) {
      editTracker.start(file, fileService.get(file));
      editTracker.delete(file);
      fileService.delete(file);

      continue;
    }

    initialFiles.push({ file, depth: -1 });
  }

  // sort initial files by depth so that we process the files closest to the entrypoints first
  initialFiles.sort((a, b) => a.depth - b.depth);

  const wholeReexportsToBeDeleted: { file: string; specifier: string }[] = [];

  const taskManager = new TaskManager(async (c) => {
    // if the file is not in the file service, it means it has been deleted in a previous iteration
    if (!fileService.exists(c.file)) {
      return;
    }

    const vertex = dependencyGraph.vertexes.get(c.file);

    await Promise.resolve();

    if (c.signal.aborted) {
      return;
    }

    const fn = pool ? pool.run.bind(pool) : processFile;

    const result = await fn({
      targetFile: c.file,
      vertexes: dependencyGraph.eject(),
      files: fileService.eject(),
      deleteUnusedFile,
      enableCodeFix,
      options,
      projectRoot,
    });

    if (c.signal.aborted) {
      return;
    }

    switch (result.operation) {
      case 'delete': {
        editTracker.start(c.file, fileService.get(c.file));

        if (entrypoints.includes(c.file)) {
          editTracker.end(c.file);
          break;
        }

        editTracker.delete(c.file);
        fileService.delete(c.file);

        if (vertex) {
          for (const v of vertex.from) {
            const target = dependencyGraph.vertexes.get(v);

            if (!target) {
              continue;
            }

            const specifier = target.data.wholeReexportSpecifier.get(c.file);

            if (specifier) {
              wholeReexportsToBeDeleted.push({ file: v, specifier });
            }
          }

          dependencyGraph.deleteVertex(c.file);

          if (recursive) {
            c.add(
              ...Array.from(vertex.to).filter((f) => !entrypoints.includes(f)),
            );
          }
        }
        break;
      }
      case 'edit': {
        editTracker.start(c.file, fileService.get(c.file));
        for (const item of result.removedExports) {
          editTracker.removeExport(item.fileName, {
            code: item.code,
            position: item.position,
          });
        }
        editTracker.end(c.file);
        fileService.set(c.file, result.content);

        if (vertex && result.removedExports.length > 0 && recursive) {
          c.add(
            ...Array.from(vertex.to).filter((f) => !entrypoints.includes(f)),
          );
        }
        break;
      }
    }
  });

  await taskManager.execute(initialFiles.map((v) => v.file));

  for (const item of wholeReexportsToBeDeleted) {
    if (!fileService.exists(item.file)) {
      continue;
    }
    const content = fileService.get(item.file);
    const result = removeWholeExportSpecifier(content, item.specifier);

    if (!result) {
      continue;
    }

    fileService.set(item.file, result.content);

    editTracker.start(item.file, content);
    editTracker.removeExport(item.file, result.info);
    editTracker.end(item.file);
  }
};

const isBrowser = typeof window !== 'undefined';
import * as path from 'path';

type PdfWorkerDestroy = () => void | Promise<void>;

interface PdfLoadingTask {
  promise: Promise<unknown>;
  destroy: PdfWorkerDestroy;
}

interface PdfJsExports {
  GlobalWorkerOptions: {
    workerSrc: string | null;
  };
  getDocument: (src: unknown) => PdfLoadingTask;
}

let shimInstalled = false;

type ModuleInternal = typeof import('module') & {
  _resolveFilename: (request: string, parent: NodeModule | undefined, isMain: boolean, options?: unknown) => string;
  _cache: Record<string, NodeModule>;
  _nodeModulePaths?: (from: string) => string[];
  Module: { new (id: string): NodeModule };
};

export async function installPdfJsShim(): Promise<void> {
  if (shimInstalled || isBrowser) {
    return;
  }

  shimInstalled = true;

  const imported = await import('module');
  const moduleInternal = imported as unknown as ModuleInternal;

  const shimModuleId = path.join(__dirname, '__pdfjs_stub__.js');
  const originalResolve = moduleInternal._resolveFilename;
  const ModuleCtor = moduleInternal.Module as unknown as { new (id: string): NodeModule };
  const shimModule = new ModuleCtor(shimModuleId);
  (shimModule as { filename: string }).filename = shimModuleId;
  (shimModule as { paths: string[] }).paths =
    typeof moduleInternal._nodeModulePaths === 'function'
      ? moduleInternal._nodeModulePaths(__dirname)
      : [];
  (shimModule as { loaded: boolean }).loaded = true;
  (shimModule as { exports: PdfJsExports }).exports = createPdfJsStub();
  moduleInternal._cache[shimModuleId] = shimModule;

  moduleInternal._resolveFilename = function resolveFilenamePatched(
    request: string,
    parent: NodeModule | undefined,
    isMain: boolean,
    options?: unknown
  ): string {
    if (request === 'pdfjs-dist/legacy/build/pdf') {
      return shimModuleId;
    }

    return originalResolve.call(this, request, parent, isMain, options);
  };
}

function createPdfJsStub(): PdfJsExports {
  return {
    GlobalWorkerOptions: {
      workerSrc: null
    },
    getDocument(): PdfLoadingTask {
      const error = new Error('PDF support is unavailable in the Bandit Stealth extension environment.');
      return {
        promise: Promise.reject(error),
        destroy: () => undefined
      };
    }
  };
}

import {ProviderVersionMismatchError, validateProviderModuleVersion, validateProviderModuleSet} from './providerVersion';
import axios from "axios";
import { platformAxiosAdapter } from "../../platform/network";
import {
  extensionStorage,
  ProviderExtension,
  ProviderModule,
  ProviderSource,
} from "../storage/extensionStorage";
import { mainStorage } from "../storage/StorageService";
import {parseProviderIntegrity, verifyProviderModule, type ProviderIntegrity} from './providerIntegrity';
import { sourceTokenStorage } from "../storage/sourceTokenStorage";
import {
  getSourceRequestHeaders,
  validateSourceTransport,
  throwIfRateLimited,
  throwIfSourceForbidden,
} from "./sourceRequests";
export { isRateLimitError, throwIfRateLimited } from "./sourceRequests";
import {
  createProviderSource,
  getProviderFilesUrl,
  isValidProviderPath,
} from "../utils/helpers";

// A private source answers 401, 403 or 404 when its token is wrong, expired
// or has no access. Check this before reporting other source errors.
const throwIfSourceAccessDenied = (error: unknown, author: string): void => {
  const status = (error as any)?.response?.status;
  if (
    sourceTokenStorage.has(author) &&
    (status === 401 || status === 403 || status === 404)
  ) {
    throw new Error(
      "Cannot access this private source. Check that the access token is valid and has read access.",
    );
  }
};

/**
 * Extension manager service for handling dynamic provider loading
 */
const isNewerInstalledVersion = (installed: string, requested: string): boolean => {
  const current = installed.split('.').map(part => parseInt(part, 10) || 0);
  const next = requested.split('.').map(part => parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(current.length, next.length); i++) {
    if ((current[i] || 0) !== (next[i] || 0)) return (current[i] || 0) > (next[i] || 0);
  }
  return false;
};

export class ExtensionManager {
  private static instance: ExtensionManager;
  private readonly legacyCustomProviderBaseUrlKey = "customProviderBaseUrl";

  private testMode = false;
  private baseUrlTestMode = "http://localhost:3001";

  private getManifest = (url: string) => {
    return `${url}/manifest.json`;
  };

  private getActiveSource(source?: ProviderSource): ProviderSource | undefined {
    if (source) {
      // Installed providers keep only author and url. Fill in the stored
      // manifestUrl so update checks of custom sources fetch the right file.
      if (!source.manifestUrl) {
        const stored = extensionStorage
          .getProviderSources()
          .find((s) => s.author === source.author);
        if (stored?.manifestUrl) {
          return { ...source, manifestUrl: stored.manifestUrl };
        }
      }
      return source;
    }

    return extensionStorage.getProviderSource();
  }

  private migrateLegacyCustomProviderSource(): void {
    if (extensionStorage.getProviderSources().length > 0) {
      return;
    }

    const legacyValue =
      mainStorage.getString(this.legacyCustomProviderBaseUrlKey)?.trim() || "";
    if (!legacyValue) {
      return;
    }

    try {
      const source = createProviderSource(legacyValue);
      extensionStorage.addProviderSources(source.author, source.url);
      extensionStorage.setDefaultProviderSource(source.author);

      const installedProviders = extensionStorage.getInstalledProviders();
      const migratedInstalledProviders = installedProviders.map((provider) => {
        if (provider.source?.author && provider.source?.url) {
          return provider;
        }

        return {
          ...provider,
          source: {
            author: source.author,
            url: source.url,
          },
        };
      });

      extensionStorage.setInstalledProviders(migratedInstalledProviders);
      console.log("Migrated customProviderBaseUrl to provider source");
    } catch (error) {
      console.warn("Failed to migrate customProviderBaseUrl:", error);
    } finally {
      mainStorage.delete(this.legacyCustomProviderBaseUrlKey);
    }
  }

  private defaultProvidersTask?: Promise<void>;

  /**
   * The fork works out of the box: the Zenda-Cross provider source is added
   * and Torrentio (which carries the Russian and international torrent
   * sources) is installed once. Removing them later is the user's choice.
   */
  ensureDefaultProviders(): Promise<void> {
    const key = "forkDefaultProviders:v1";
    if (mainStorage.getBool(key)) return Promise.resolve();
    if (this.defaultProvidersTask) return this.defaultProvidersTask;
    this.defaultProvidersTask = (async () => {
      this.migrateLegacyCustomProviderSource();
      let source = extensionStorage
        .getProviderSources()
        .find((item) => item.author === "Zenda-Cross");
      if (!source) {
        source = createProviderSource("Zenda-Cross");
        extensionStorage.addProviderSources(source.author, source.url, source.manifestUrl);
        if (extensionStorage.getProviderSources().length === 1) {
          extensionStorage.setDefaultProviderSource(source.author);
        }
      }
      const author = source.author;
      const installed = extensionStorage
        .getInstalledProviders()
        .some((provider) => provider.value === "torrentio" && provider.source?.author === author);
      if (!installed) {
        const manifest = await this.fetchManifest(source, true);
        const provider = manifest.find((item) => item.value === "torrentio" && !item.disabled);
        if (!provider) throw new Error("Torrentio is unavailable in the default provider source");
        await this.installProvider(provider);
      }
      mainStorage.setBool(key, true);
    })().finally(() => {
      this.defaultProvidersTask = undefined;
    });
    return this.defaultProvidersTask;
  }

  // Test mode configuration
  private testModuleCache = new Map<
    string,
    { module: ProviderModule; cachedAt: number }
  >();
  private testModuleDownloads = new Map<string, Promise<ProviderModule>>();

  static getInstance(): ExtensionManager {
    if (!ExtensionManager.instance) {
      ExtensionManager.instance = new ExtensionManager();
    }
    return ExtensionManager.instance;
  }

  /**
   * Fetch latest manifest from the configured provider source
   */
  async fetchManifest(
    sourceOrForce?: ProviderSource | boolean,
    force = false,
  ): Promise<ProviderExtension[]> {
    const source =
      sourceOrForce && typeof sourceOrForce === "object"
        ? sourceOrForce
        : undefined;
    const shouldForce =
      typeof sourceOrForce === "boolean" ? sourceOrForce : force;
    const activeSource = this.getActiveSource(source);

    if (!activeSource) {
      throw new Error("No provider source configured");
    }

    try {
      // Check cache first
      if (
        !shouldForce &&
        !extensionStorage.isManifestCacheExpired(activeSource.author)
      ) {
        const cached = extensionStorage.getManifestCache(activeSource.author);
        if (cached.length > 0) {
          return cached;
        }
      }

      const manifestBase = this.testMode
        ? `${this.baseUrlTestMode}/manifest.json`
        : activeSource.manifestUrl || this.getManifest(activeSource.url);
      const manifestUrl = shouldForce
        ? `${manifestBase}${manifestBase.includes("?") ? "&" : "?"}t=${Date.now()}`
        : manifestBase;
      console.log("Fetching manifest from:", manifestUrl);
      if (!this.testMode) validateSourceTransport(manifestUrl);
      const response = await axios.get(manifestUrl, {
        timeout: 10000,
        adapter: platformAxiosAdapter,
        headers: this.testMode
          ? undefined
          : getSourceRequestHeaders(activeSource.author, manifestUrl),
      });

      if (!response.data || !Array.isArray(response.data)) {
        throw new Error("Invalid manifest format");
      }

      const providers: ProviderExtension[] = response.data
        // A path that leaves the source folder is unsafe; skip that entry.
        .filter(
          (item: any) =>
            item?.path === undefined || isValidProviderPath(item.path),
        )
        .map((item: any) => ({
          value: item.value,
          display_name: item.display_name,
          disabled: item.disabled || false,
          source: { author: activeSource.author, url: activeSource.url },
          version: item.version,
          icon: item.icon || "",
          type: item.type || "global",
          installed: false,
          hasSettings: item.hasSettings || false,
          ...(item.path ? { path: item.path } : {}),
          ...(item.integrity === undefined ? {} : {integrity:parseProviderIntegrity(item.integrity)}),
        }));

      // Cache the manifest
      extensionStorage.setManifestCache(providers, activeSource.author);
      extensionStorage.setAvailableProviders(activeSource.author, providers);

      return providers;
    } catch (error) {
      console.error("Failed to fetch manifest:", error);
      if (!this.testMode) {
        throwIfSourceAccessDenied(error, activeSource.author);
      }
      throwIfRateLimited(error);
      throwIfSourceForbidden(error);

      // Return cached data if available
      const cached = extensionStorage.getManifestCache(activeSource.author);
      if (cached.length > 0) {
        return cached;
      }

      throw error;
    }
  }

  /**
   * Download and cache provider modules
   */
  async downloadProviderModules(
    sourceUrl: string,
    sourceAuthor: string,
    providerValue: string,
    version: string,
    path?: string,
    integrity?: ProviderIntegrity,
    cacheResult = true,
  ): Promise<ProviderModule> {
    if (this.testMode) {
      return this.downloadTestProviderModule(providerValue);
    }
    try {
      const requiredFiles = ["posts", "meta", "stream", "catalog"];
      const optionalFiles = ["episodes", "settings"];
      const allFiles = [...requiredFiles, ...optionalFiles];
      const filesUrl = getProviderFilesUrl(sourceUrl, providerValue, path);
      validateSourceTransport(filesUrl);

      const modules: Record<string, string> = {};
      const downloadPromises = allFiles.map(async (fileName) => {
        try {
          // Retry a stale CDN body once with a fresh cache key; never commit a partial set.
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const url = `${filesUrl}/${fileName}.js?v=${encodeURIComponent(version)}&t=${Date.now()}-${attempt}`;
              console.log(`Downloading: ${url}`);

              const response = await axios.get<string>(url, {
                timeout: 15000,
                responseType:'text', transformResponse:[value => value], maxContentLength:2_000_000,
                adapter: platformAxiosAdapter,
                headers: getSourceRequestHeaders(sourceAuthor, url),
              });

              if (typeof response.data !== 'string' || !response.data.trim()) throw new Error(`Invalid module response: ${fileName}.js`);
              if (typeof response.data === 'string' && response.data) {
                validateProviderModuleVersion(response.data, providerValue, version, fileName);
                await verifyProviderModule(fileName,response.data,integrity);
                modules[fileName] = response.data;
              }
              break;
            } catch (error) {
              if (!(error instanceof ProviderVersionMismatchError) || attempt === 1) throw error;
            }
          }
        } catch (error) {
          if (integrity?.[fileName as keyof ProviderIntegrity]) throw error;
          if (requiredFiles.includes(fileName)) {
            throwIfSourceAccessDenied(error, sourceAuthor);
          }
          throwIfRateLimited(error);
          throwIfSourceForbidden(error);
          if (requiredFiles.includes(fileName)) {
            console.error(
              `Failed to download ${fileName}.js for ${providerValue}:`,
              error,
            );
            throw error;
          } else {
            const status = (error as {response?: {status?: number}})?.response?.status;
            if (status !== 404 && status !== 410) throw error;
            console.warn(
              `Optional file ${fileName}.js not found for ${providerValue}`,
            );
          }
        }
      });

      await Promise.all(downloadPromises);
      validateProviderModuleSet(modules, providerValue, version);

      // Verify required files were downloaded
      const missingRequired = requiredFiles.filter((file) => !modules[file]);
      if (missingRequired.length > 0) {
        throw new Error(
          `Missing required files: ${missingRequired.join(", ")}`,
        );
      }

      const providerModule: ProviderModule = {
        value: providerValue,
        sourceAuthor,
        version,
        modules: {
          posts: modules.posts,
          meta: modules.meta,
          stream: modules.stream,
          catalog: modules.catalog,
          episodes: modules.episodes,
          settings: modules.settings,
        },
        cachedAt: Date.now(),
      };

      // Cache the modules
      if (cacheResult) extensionStorage.cacheProviderModules(providerModule);

      return providerModule;
    } catch (error) {
      console.error(`Failed to download modules for ${providerValue}:`, error);
      throw error;
    }
  }

  async downloadTestProviderModule(
    providerValue: string,
  ): Promise<ProviderModule> {
    try {
      const url = `${this.baseUrlTestMode}/dist/${providerValue}/`;
      const cacheBust = Date.now();
      const requiredFiles = ["posts", "meta", "stream", "catalog"];
      const optionalFiles = ["episodes", "settings"];
      const allFiles = [...requiredFiles, ...optionalFiles];
      const modules: Record<string, string> = {};
      const downloadPromises = allFiles.map(async (fileName) => {
        try {
          const fileUrl = `${url}${fileName}.js?v=${cacheBust}`;
          console.log(`Downloading test module: ${fileUrl}`);

          const response = await axios.get(fileUrl, {
            timeout: 15000,
            adapter: platformAxiosAdapter,
          });

          if (response.data) {
            modules[fileName] = response.data;
          } else {
            throw new Error(`No data received for ${fileName}`);
          }
        } catch (error) {
          // Only log error for required files
          if (requiredFiles.includes(fileName)) {
            console.error(
              `Failed to download ${fileName}.js for ${providerValue}:`,
              error,
            );
            throw error;
          } else {
            console.warn(
              `Optional file ${fileName}.js not found for ${providerValue}`,
            );
          }
        }
      });

      await Promise.all(downloadPromises);

      if (!modules.posts) {
        throw new Error(`No data received for ${providerValue}`);
      }

      const providerModule: ProviderModule = {
        value: providerValue,
        version: "test",
        modules: {
          posts: modules.posts,
          meta: modules.meta,
          stream: modules.stream,
          catalog: modules.catalog,
          episodes: modules.episodes,
          settings: modules.settings,
        },
        cachedAt: Date.now(),
      };

      // Cache the test module
      this.testModuleCache.set(providerValue, {
        module: providerModule,
        cachedAt: Date.now(),
      });

      return providerModule;
    } catch (error) {
      console.error(
        `Failed to download test module for ${providerValue}:`,
        error,
      );
      throw error;
    }
  }

  /**
   * Install a provider
   */
  async installProvider(provider: ProviderExtension): Promise<void> {
    try {
      // Download the provider modules
      await this.downloadProviderModules(
        provider.source.url,
        provider.source.author,
        provider.value,
        provider.version,
        provider.path,
        provider.integrity,
      );

      // Mark as installed
      extensionStorage.installProvider(provider);

      console.log(`Successfully installed provider: ${provider.display_name}`);
    } catch (error) {
      console.error(
        `Failed to install provider ${provider.display_name}:`,
        error,
      );
      throw error;
    }
  }

  /**
   * Uninstall a provider
   */
  uninstallProvider(providerValue: string, sourceAuthor?: string): void {
    extensionStorage.uninstallProvider(providerValue, sourceAuthor);
    console.log(`Uninstalled provider: ${providerValue}`);
  }

  /**
   * Update a provider
   */
  async updateProvider(provider: ProviderExtension, shouldApply: () => boolean = () => true): Promise<boolean> {
    if (!shouldApply() || !extensionStorage.isProviderInstalled(provider.value, provider.source.author)) {
      return false;
    }
    try {
      // Download updated modules
      const downloaded = await this.downloadProviderModules(
        provider.source.url,
        provider.source.author,
        provider.value,
        provider.version,
        provider.path,
        provider.integrity,
        false,
      );

      // Uninstall or source removal during the download takes precedence.
      if (!extensionStorage.isProviderInstalled(provider.value, provider.source.author)) {
        extensionStorage.removeProviderModules(provider.value, provider.source.author);
        return false;
      }

      // A newer manual/automatic update may have finished while this download ran.
      // The check and synchronous commit share one JS turn, so stale code cannot win.
      const latest = extensionStorage.getInstalledProviders().find(
        item => item.value === provider.value && item.source?.author === provider.source.author,
      );
      if (latest && isNewerInstalledVersion(latest.version, provider.version)) return false;
      // Recheck immediately before committing code and version together.
      if (!shouldApply()) return false;
      extensionStorage.cacheProviderModules(downloaded);

      // Update the existing installation record.
      extensionStorage.installProvider(provider);

      console.log(`Successfully updated provider: ${provider.display_name}`);
      return true;
    } catch (error) {
      console.error(
        `Failed to update provider ${provider.display_name}:`,
        error,
      );
      throw error;
    }
  }
  /**
   * Get cached provider modules (works synchronously for both normal and test mode)
   */
  getProviderModules(
    providerValue: string,
    sourceAuthor?: string,
  ): ProviderModule | undefined {
    if (this.testMode) {
      // In test mode, return cached test module and trigger background refresh
      const cached = this.testModuleCache.get(providerValue);
      if (cached) {
        // Trigger background refresh for next call
        this.refreshTestModuleInBackground(providerValue);

        return cached.module;
      }
      this.refreshTestModuleInBackground(providerValue);

      // If no test cache exists, fall back to regular cache
      console.warn(
        `No test module cache found for ${providerValue}, falling back to regular cache`,
      );
    }

    return extensionStorage.getProviderModules(providerValue, sourceAuthor);
  }

  async getProviderModulesAsync(
    providerValue: string,
    sourceAuthor?: string,
  ): Promise<ProviderModule | undefined> {
    if (!this.testMode) {
      return extensionStorage.getProviderModules(providerValue, sourceAuthor);
    }

    const activeDownload = this.testModuleDownloads.get(providerValue);
    if (activeDownload) {
      return activeDownload;
    }

    const download = this.downloadTestProviderModule(providerValue).finally(
      () => {
        this.testModuleDownloads.delete(providerValue);
      },
    );
    this.testModuleDownloads.set(providerValue, download);

    return download;
  }

  /**
   * Check if provider needs update
   */
  checkForUpdates(author?: string): ProviderExtension[] {
    const activeAuthor = author || this.getActiveSource()?.author;
    if (!activeAuthor) {
      return [];
    }
    return extensionStorage.getProvidersNeedingUpdate(activeAuthor);
  }

  /**
   * Initialize extension system
   */
  async initialize(): Promise<void> {
    try {
      this.migrateLegacyCustomProviderSource();

      // Load providers from cache
      const source = this.getActiveSource();
      const installed = extensionStorage.getInstalledProviders();
      const available = source
        ? extensionStorage.getAvailableProviders(source.author)
        : [];

      console.log(`Loaded ${installed.length} installed providers`);
      console.log(`Loaded ${available.length} available providers`);

      if (!source) {
        console.log("No provider source configured yet");
        return;
      }

      // Try to fetch latest manifest if cache is expired
      if (extensionStorage.isManifestCacheExpired(source.author)) {
        try {
          await this.fetchManifest(source, false);
        } catch (error) {
          console.warn("Failed to refresh manifest on startup:", error);
        }
      }
    } catch (error) {
      console.error("Failed to initialize extension system:", error);
    }
  }

  /**
   * Enable/disable test mode
   */
  setTestMode(enabled: boolean): void {
    this.testMode = enabled;
    console.log(`Test mode ${enabled ? "enabled" : "disabled"}`);
  }

  /**
   * Pre-fetch test modules to ensure they're available synchronously
   */
  async preFetchTestModules(providerValues: string[]): Promise<void> {
    if (!this.testMode) {
      return;
    }

    console.log("Pre-fetching test modules for:", providerValues);

    const fetchPromises = providerValues.map(async (providerValue) => {
      try {
        const module = await this.downloadTestProviderModule(providerValue);
        this.testModuleCache.set(providerValue, {
          module,
          cachedAt: Date.now(),
        });
        console.log(`Pre-fetched test module for: ${providerValue}`);
      } catch (error) {
        console.error(
          `Failed to pre-fetch test module for ${providerValue}:`,
          error,
        );
      }
    });

    await Promise.allSettled(fetchPromises);
  }
  /**
   * Refresh test module in background if needed
   */
  private refreshTestModuleInBackground(providerValue: string): void {
    if (!this.testMode) {
      return;
    }

    // Refresh in background without blocking
    this.downloadTestProviderModule(providerValue)
      .then((module) => {
        this.testModuleCache.set(providerValue, {
          module,
          cachedAt: Date.now(),
        });
        console.log(`Background refreshed test module for: ${providerValue}`);
      })
      .catch((error) => {
        console.error(
          `Failed to background refresh test module for ${providerValue}:`,
          error,
        );
      });
  }
}

/**
 * Global extension manager instance
 */
export const extensionManager = ExtensionManager.getInstance();

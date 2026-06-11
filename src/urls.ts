import type { AppConfig } from "./config";

export function viewerUrl(config: AppConfig, id: string): string {
  return withPath(config.publicBaseUrl, `/v/${id}`);
}

export function contentRootUrl(config: AppConfig, id: string): string {
  if (config.contentBaseUrl) {
    return withPath(config.contentBaseUrl, `/${id}/`);
  }
  return withPath(config.publicBaseUrl, `/content/${id}/`);
}

export function contentFrameSrc(config: AppConfig, id: string, revision?: number): string {
  const url = new URL(contentRootUrl(config, id));
  if (revision && revision > 0) {
    url.searchParams.set("v", String(revision));
  }
  return url.toString();
}

export function contentOrigin(config: AppConfig): string | null {
  return config.contentBaseUrl ? new URL(config.contentBaseUrl).origin : null;
}

export function isContentHost(config: AppConfig, requestUrl: URL): boolean {
  if (!config.contentBaseUrl) {
    return false;
  }
  return requestUrl.host === new URL(config.contentBaseUrl).host;
}

function withPath(base: string, path: string): string {
  const url = new URL(base);
  url.pathname = path;
  url.search = "";
  url.hash = "";
  return url.toString();
}

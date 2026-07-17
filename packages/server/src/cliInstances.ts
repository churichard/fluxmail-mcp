import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EmailError } from '@fluxmail/core';
import { resolveDataDir } from './config.js';
import { createContext } from './context.js';
import { createApp } from './http/app.js';

export interface LocalInstanceProfile {
  kind: 'local';
}

export interface RemoteInstanceProfile {
  kind: 'remote';
  serverUrl: string;
}

export type InstanceProfile = LocalInstanceProfile | RemoteInstanceProfile;

export interface CliInstanceConfig {
  active?: string;
  instances: Record<string, InstanceProfile>;
}

interface CliCredentials {
  sessions: Record<string, string>;
}

function cliDirectory(): string {
  return path.join(resolveDataDir(), 'cli');
}

export function instanceConfigPath(): string {
  return path.join(cliDirectory(), 'instances.json');
}

export function credentialPath(): string {
  return path.join(cliDirectory(), 'credentials.json');
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw new EmailError('invalid_request', `Could not read ${filePath}: ${(error as Error).message}`);
  }
}

function writePrivateJson(filePath: string, value: unknown): void {
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(filePath, 0o600);
}

export function loadInstanceConfig(): CliInstanceConfig {
  return readJson(instanceConfigPath(), { instances: {} });
}

function saveInstanceConfig(config: CliInstanceConfig): void {
  writePrivateJson(instanceConfigPath(), config);
}

function loadCredentials(): CliCredentials {
  return readJson(credentialPath(), { sessions: {} });
}

function saveCredentials(credentials: CliCredentials): void {
  writePrivateJson(credentialPath(), credentials);
}

function validInstanceName(name: string): string {
  const normalized = name.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(normalized)) {
    throw new EmailError('invalid_request', 'Instance names may contain letters, numbers, underscores, and hyphens.');
  }
  return normalized;
}

export function validateRemoteServerUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EmailError('invalid_request', 'Server URL must be a valid absolute URL.');
  }
  if (url.username || url.password) {
    throw new EmailError('invalid_request', 'Server URLs cannot contain credentials.');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new EmailError('invalid_request', 'Remote instances require HTTPS except on localhost.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export function saveLocalInstance(name = 'local'): void {
  const instanceName = validInstanceName(name);
  const config = loadInstanceConfig();
  config.instances[instanceName] = { kind: 'local' };
  config.active = instanceName;
  saveInstanceConfig(config);
}

export function saveRemoteInstance(name: string, serverUrl: string): void {
  const instanceName = validInstanceName(name);
  const config = loadInstanceConfig();
  config.instances[instanceName] = { kind: 'remote', serverUrl: validateRemoteServerUrl(serverUrl) };
  config.active ??= instanceName;
  saveInstanceConfig(config);
}

export function useInstance(name: string): void {
  const config = loadInstanceConfig();
  if (!config.instances[name]) throw new EmailError('not_found', `No CLI instance named "${name}".`);
  config.active = name;
  saveInstanceConfig(config);
}

export function removeInstance(name: string): void {
  const config = loadInstanceConfig();
  if (!config.instances[name]) throw new EmailError('not_found', `No CLI instance named "${name}".`);
  delete config.instances[name];
  if (config.active === name) config.active = Object.keys(config.instances)[0];
  saveInstanceConfig(config);
  const credentials = loadCredentials();
  delete credentials.sessions[name];
  saveCredentials(credentials);
}

export function resolveInstance(name?: string): { name: string; profile: InstanceProfile; token?: string } {
  const config = loadInstanceConfig();
  const selected = name ?? config.active;
  if (!selected)
    throw new EmailError(
      'invalid_request',
      'No CLI instance is configured. Run "fluxmail setup" or "fluxmail login --server <url>".',
    );
  const profile = config.instances[selected];
  if (!profile) throw new EmailError('not_found', `No CLI instance named "${selected}".`);
  return { name: selected, profile, token: loadCredentials().sessions[selected] };
}

export function saveSessionToken(instanceName: string, token: string): void {
  const credentials = loadCredentials();
  credentials.sessions[instanceName] = token;
  saveCredentials(credentials);
}

export function clearSessionToken(instanceName: string): void {
  const credentials = loadCredentials();
  delete credentials.sessions[instanceName];
  saveCredentials(credentials);
}

export class InstanceClient {
  constructor(
    readonly name: string,
    readonly profile: InstanceProfile,
    private readonly token?: string,
  ) {}

  async request(pathname: string, init: RequestInit = {}, authenticated = true): Promise<Response> {
    const headers = new Headers(init.headers);
    if (authenticated) {
      if (!this.token) throw new EmailError('permission_denied', `Log in to instance "${this.name}" first.`);
      headers.set('authorization', `Bearer ${this.token}`);
    }
    if (this.profile.kind === 'local') {
      const context = createContext();
      return createApp(context).request(pathname, { ...init, headers });
    }
    const baseUrl = new URL(`${this.profile.serverUrl}/`);
    const url = new URL(pathname.replace(/^\/+/, ''), baseUrl);
    if (url.origin !== baseUrl.origin) {
      throw new EmailError('invalid_request', 'Remote request paths must stay on the configured server.');
    }
    const response = await fetch(url, { ...init, headers, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      throw new EmailError(
        'permission_denied',
        'The remote server redirected an authenticated request. Refusing to forward credentials.',
      );
    }
    return response;
  }

  async json<T>(pathname: string, init: RequestInit = {}, authenticated = true): Promise<T> {
    const response = await this.request(pathname, init, authenticated);
    const body = (await response.json()) as { data?: T; error?: { message?: string } };
    if (!response.ok)
      throw new EmailError('invalid_request', body.error?.message ?? `Request failed with HTTP ${response.status}.`);
    return body.data as T;
  }
}

export function instanceClient(name?: string, requireToken = true): InstanceClient {
  const selected = resolveInstance(name);
  if (requireToken && !selected.token)
    throw new EmailError('permission_denied', `Log in to instance "${selected.name}" first.`);
  return new InstanceClient(selected.name, selected.profile, selected.token);
}

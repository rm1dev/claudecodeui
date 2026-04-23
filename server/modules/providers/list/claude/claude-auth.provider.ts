import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import spawn from 'cross-spawn';

import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

type ClaudeCredentialsStatus = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error?: string;
};

export class ClaudeProviderAuth implements IProviderAuth {
  /**
   * Checks whether the Claude Code CLI is available on this host.
   */
  private checkInstalled(): boolean {
      const cliPath = process.env.CLAUDE_CLI_PATH || 'claude';
      try {
        spawn.sync(cliPath, ['--version'], { stdio: 'ignore', timeout: 5000 });
        return true;
      } catch {
        return false;
      }
  }

  /**
   * Returns Claude installation and credential status using Claude Code's auth priority.
   *
   * Note: credentials are checked first because the SDK (>= 0.2.113) ships a bundled
   * native binary and can authenticate even when the `claude` CLI is not on PATH.
   * Blocking on `installed` would cause a false "Not connected" in that case.
   */
  async getStatus(): Promise<ProviderAuthStatus> {
    const credentials = await this.checkCredentials();

    if (credentials.authenticated) {
      return {
        installed: true,
        provider: 'claude',
        authenticated: true,
        email: credentials.email || (credentials.method === 'desktop_app' ? 'Claude Desktop' : 'Authenticated'),
        method: credentials.method,
      };
    }

    // Credentials not found — check CLI installation to give a useful error message.
    const installed = this.checkInstalled();

    return {
      installed,
      provider: 'claude',
      authenticated: false,
      email: credentials.email,
      method: credentials.method,
      error: installed
        ? (credentials.error || 'Not authenticated')
        : 'Claude Code CLI is not installed',
    };
  }

  /**
   * Reads Claude settings env values that the CLI can use even when the server process env is empty.
   */
  private async loadSettingsEnv(): Promise<Record<string, unknown>> {
    try {
      const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
      const content = await readFile(settingsPath, 'utf8');
      const settings = readObjectRecord(JSON.parse(content));
      return readObjectRecord(settings?.env) ?? {};
    } catch {
      return {};
    }
  }

  /**
   * Checks Claude credentials in the same priority order used by Claude Code.
   */
  private async checkCredentials(): Promise<ClaudeCredentialsStatus> {
    if (process.env.ANTHROPIC_API_KEY?.trim()) {
      return { authenticated: true, email: 'API Key Auth', method: 'api_key' };
    }

    const settingsEnv = await this.loadSettingsEnv();
    if (readOptionalString(settingsEnv.ANTHROPIC_API_KEY)) {
      return { authenticated: true, email: 'API Key Auth', method: 'api_key' };
    }

    if (readOptionalString(settingsEnv.ANTHROPIC_AUTH_TOKEN)) {
      return { authenticated: true, email: 'Configured via settings.json', method: 'api_key' };
    }

    try {
      const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
      const content = await readFile(credPath, 'utf8');
      const creds = readObjectRecord(JSON.parse(content)) ?? {};
      const oauth = readObjectRecord(creds.claudeAiOauth);
      const accessToken = readOptionalString(oauth?.accessToken);

      if (accessToken) {
        const expiresAt = typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : undefined;
        const refreshToken = readOptionalString(oauth?.refreshToken);
        const email = readOptionalString(creds.email) ?? readOptionalString(creds.user) ?? null;

        // Token is still valid.
        if (!expiresAt || Date.now() < expiresAt) {
          return {
            authenticated: true,
            email,
            method: 'credentials_file',
          };
        }

        // Token expired but a refresh token exists — the CLI will auto-refresh it on next use.
        if (refreshToken) {
          return {
            authenticated: true,
            email,
            method: 'credentials_file',
          };
        }

        return {
          authenticated: false,
          email,
          method: 'credentials_file',
          error: 'OAuth token has expired. Please re-authenticate with claude login',
        };
      }
    } catch {
      // credentials file does not exist or is unreadable — fall through to Desktop app check.
    }

    // Fallback: Claude Desktop app stores an encrypted OAuth token in its own config.
    // The token itself cannot be decrypted here, but its presence means the bundled
    // claude binary (used by the SDK) can authenticate via the Desktop app session.
    const desktopAuth = await this.checkClaudeDesktopAuth();
    if (desktopAuth.authenticated) {
      return desktopAuth;
    }

    return { authenticated: false, email: null, method: null };
  }

  /**
   * Checks if the Claude Desktop app has a stored OAuth token.
   * This covers the case where users authenticate via Claude Desktop rather than
   * `claude login`, which stores credentials in the Desktop app config instead of
   * ~/.claude/.credentials.json.
   */
  private async checkClaudeDesktopAuth(): Promise<ClaudeCredentialsStatus> {
    let configPath: string;

    if (process.platform === 'darwin') {
      configPath = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'config.json');
    } else if (process.platform === 'win32') {
      configPath = path.join(os.homedir(), 'AppData', 'Roaming', 'Claude', 'config.json');
    } else {
      configPath = path.join(os.homedir(), '.config', 'Claude', 'config.json');
    }

    try {
      const content = await readFile(configPath, 'utf8');
      const config = readObjectRecord(JSON.parse(content));
      // The token is stored encrypted; its presence indicates an active Desktop session.
      const tokenCache = readOptionalString(config?.['oauth:tokenCache']);
      if (tokenCache) {
        return { authenticated: true, email: null, method: 'desktop_app' };
      }
    } catch {
      // Desktop app config not found or unreadable.
    }

    return { authenticated: false, email: null, method: null };
  }
}

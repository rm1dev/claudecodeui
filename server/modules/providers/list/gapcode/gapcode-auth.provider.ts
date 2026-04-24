import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import spawn from 'cross-spawn';

import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

type GapcodeCredentialsStatus = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error?: string;
};

export class GapcodeProviderAuth implements IProviderAuth {
  private checkInstalled(): boolean {
    try {
      spawn.sync('gapcode', ['--version'], { stdio: 'ignore', timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  async getStatus(): Promise<ProviderAuthStatus> {
    const installed = this.checkInstalled();
    const credentials = await this.checkCredentials();

    return {
      installed,
      provider: 'gapcode',
      authenticated: credentials.authenticated,
      email: credentials.email,
      method: credentials.method,
      error: credentials.authenticated ? undefined : credentials.error || 'Not authenticated',
    };
  }

  private async checkCredentials(): Promise<GapcodeCredentialsStatus> {
    try {
      const authPath = path.join(os.homedir(), '.gapcode', 'auth.json');
      const content = await readFile(authPath, 'utf8');
      const auth = readObjectRecord(JSON.parse(content)) ?? {};

      // GapCode uses auth_mode + OPENAI_API_KEY (oauth_origin style)
      const apiKey = readOptionalString(auth.OPENAI_API_KEY);
      if (apiKey) {
        const authMode = readOptionalString(auth.auth_mode);
        return {
          authenticated: true,
          email: 'API Key Auth',
          method: authMode || 'api_key',
        };
      }

      // Fallback: check tokens like codex
      const tokens = readObjectRecord(auth.tokens) ?? {};
      const idToken = readOptionalString(tokens.id_token);
      const accessToken = readOptionalString(tokens.access_token);
      if (idToken || accessToken) {
        return {
          authenticated: true,
          email: idToken ? this.readEmailFromIdToken(idToken) : 'Authenticated',
          method: 'credentials_file',
        };
      }

      return { authenticated: false, email: null, method: null, error: 'No valid credentials found' };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return {
        authenticated: false,
        email: null,
        method: null,
        error: code === 'ENOENT' ? 'GapCode not configured' : error instanceof Error ? error.message : 'Failed to read GapCode auth',
      };
    }
  }

  private readEmailFromIdToken(idToken: string): string {
    try {
      const parts = idToken.split('.');
      if (parts.length >= 2) {
        const payload = readObjectRecord(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')));
        return readOptionalString(payload?.email) ?? readOptionalString(payload?.user) ?? 'Authenticated';
      }
    } catch {
      // ignore
    }
    return 'Authenticated';
  }
}

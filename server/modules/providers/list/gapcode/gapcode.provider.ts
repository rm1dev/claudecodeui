import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import { GapcodeProviderAuth } from '@/modules/providers/list/gapcode/gapcode-auth.provider.js';
import { GapcodeMcpProvider } from '@/modules/providers/list/gapcode/gapcode-mcp.provider.js';
import { GapcodeSessionsProvider } from '@/modules/providers/list/gapcode/gapcode-sessions.provider.js';
import type { IProviderAuth, IProviderSessions } from '@/shared/interfaces.js';

export class GapcodeProvider extends AbstractProvider {
  readonly mcp = new GapcodeMcpProvider();
  readonly auth: IProviderAuth = new GapcodeProviderAuth();
  readonly sessions: IProviderSessions = new GapcodeSessionsProvider();

  constructor() {
    super('gapcode');
  }
}

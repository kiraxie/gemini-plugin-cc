/**
 * setup command — checks auth status and plugin readiness.
 */

import { createAuth } from '../lib/gemini-auth.js';

export async function runSetup(options: { check?: boolean; json?: boolean }): Promise<void> {
  const isCheck = options.check ?? false;

  let auth;
  try {
    auth = await createAuth();
  } catch (err) {
    if (isCheck) {
      // SessionStart hook — silent failure, print to stderr
      console.error(`[gemini] No authentication found. Run \`gemini auth login\` to enable Gemini features.`);
      return;
    }
    const msg = (err as Error).message;
    if (options.json) {
      console.log(JSON.stringify({ status: 'error', message: msg }, null, 2));
    } else {
      console.log(`## Gemini Plugin Setup\n\n**Status:** ❌ Not authenticated\n\n${msg}`);
    }
    return;
  }

  const hasOAuth = auth.type === 'oauth';
  const canUseCodeAssist = hasOAuth && !!auth.oauthClient;

  if (isCheck) {
    // SessionStart hook — silent success
    return;
  }

  const report = {
    status: 'ok',
    authType: auth.type,
    codeAssistAvailable: canUseCodeAssist,
    models: canUseCodeAssist
      ? ['gemini-3-flash-preview', 'gemini-2.5-pro', 'gemini-2.5-flash']
      : ['gemini-2.5-pro', 'gemini-2.5-flash'],
  };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`## Gemini Plugin Setup

**Status:** ✅ Authenticated
**Auth type:** ${auth.type}
**Code Assist API:** ${canUseCodeAssist ? '✅ Available (gemini-3 models)' : '⚠️ Not available (API key auth — gemini-2.5 only)'}

### Available models
${report.models.map(m => `- ${m}`).join('\n')}

### Next steps
- Run \`/gemini:investigate "your objective"\` to start a codebase investigation
- Run \`/gemini:analyze\` for a quick project structure scan`);
}

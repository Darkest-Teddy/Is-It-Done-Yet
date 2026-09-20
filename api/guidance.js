/**
 * `/api/guidance` on Vercel.
 *
 * Three lines, and that is the point: the handler is `server/guidance.mjs`, the same one the
 * dev server and `server/static.mjs` mount. See `server/vercel.mjs` for what the wrapper does
 * and why it is not a second implementation.
 *
 * With `QWEN_BASE_URL` unset the handler answers 503 and the app uses its local guidance, which
 * is a complete answer on its own. Nothing here is required for the app to run.
 */

import { handleGuidance } from '../server/guidance.mjs';
import { vercelHandler } from '../server/vercel.mjs';

export default vercelHandler(handleGuidance);

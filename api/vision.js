/**
 * `/api/vision` on Vercel.
 *
 * GET as well as POST. The client asks GET first to decide whether the "Identify everything"
 * control can honestly be offered, and disables it with a real reason when the answer is no --
 * so this route answering at all, even unconfigured, is what turns a dead button into an
 * explained one.
 *
 * The endpoint this replaces has been live since before the repository had a copy of it
 * (DECISIONS.md entries 27 and 29). `server/vision.mjs` is that copy, and this is the mount.
 */

import { handleVision } from '../server/vision.mjs';
import { vercelHandler } from '../server/vercel.mjs';

export default vercelHandler(handleVision);

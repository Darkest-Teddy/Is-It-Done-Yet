/**
 * `/api/speech` on Vercel.
 *
 * Kept as its own file rather than folded in with guidance for the reason `vite.config.ts`
 * gives: a deployment can have a model and no voice, or a voice and no model, and one function
 * mounting both would make that read as one switch.
 *
 * This is the route that matters most on the headset. DECISIONS.md entry 19 -- Quest Browser
 * ships no `speechSynthesis` at all, so the browser tier under this one does not exist there
 * and the only thing behind a 404 is the subtitle.
 */

import { handleSpeech } from '../server/speech.mjs';
import { vercelHandler } from '../server/vercel.mjs';

export default vercelHandler(handleSpeech);

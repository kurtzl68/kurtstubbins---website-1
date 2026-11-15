// Entry point. Only /api/* runs this Worker (see run_worker_first in wrangler.jsonc);
// every other request is served straight from the static site files.
import { handleApi } from './api.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return handleApi(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};

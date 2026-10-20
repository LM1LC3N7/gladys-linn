// -----------------------------------------------------------------------------
// The only place that talks to the network: one HTTP request to a device on
// the LAN (GET of a description, POST of a SOAP action), with a deadline, a
// size cap, no redirect and `Connection: close`. The tests inject another
// transport, or run a fake device on the loopback interface.
//
// Resolves { status, text } for any HTTP status; throws an OpenhomeError.
// -----------------------------------------------------------------------------

import http from 'node:http';
import { TIMINGS, USER_AGENT } from '../constants.js';
import { OpenhomeError } from './errors.js';

/**
 * `url` is an http: URL object (checked by the caller). `body` (a string)
 * makes it a POST. `signal` cancels it (OpenhomeError 'aborted').
 */
export function httpRequest({
  url,
  body,
  headers = {},
  timeout = TIMINGS.requestTimeout,
  maxBytes,
  signal,
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let written = false;
    let request;
    let timer;
    const onAbort = () => fail(new OpenhomeError('aborted', 'cancelled', { maybeSent: written }));
    const done = () => {
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const fail = (err) => {
      if (!settled) {
        done();
        request?.destroy();
        reject(err);
      }
    };
    const networkError = (err) =>
      new OpenhomeError('network', err?.code ? `network error (${err.code})` : 'network error', {
        // A reset after the request left: the device may have acted on it.
        maybeSent: written && err?.code !== 'ECONNREFUSED',
      });

    if (url?.protocol !== 'http:') {
      reject(new OpenhomeError('refused', 'only plain http URLs of the LAN are used'));
      return;
    }
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(
      () =>
        fail(
          new OpenhomeError('timeout', `no answer within ${(timeout / 1000).toFixed(1)} s`, {
            maybeSent: written,
          }),
        ),
      Math.max(1, timeout),
    );
    const payload = body === undefined ? undefined : Buffer.from(body, 'utf8');
    request = http.request(
      {
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port || 80,
        path: `${url.pathname}${url.search}`,
        method: payload ? 'POST' : 'GET',
        agent: false,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/xml, application/xml;q=0.9, */*;q=0.1',
          Connection: 'close',
          ...(payload ? { 'Content-Length': payload.length } : {}),
          ...headers,
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          response.resume();
          fail(new OpenhomeError('redirect', `HTTP ${status} redirect refused`, { status }));
          return;
        }
        const declared = Number(response.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes) {
          response.resume();
          fail(new OpenhomeError('too_large', `answer over ${Math.round(maxBytes / 1024)} KB`));
          return;
        }
        const chunks = [];
        let total = 0;
        response.on('data', (chunk) => {
          total += chunk.length;
          if (total > maxBytes) {
            fail(new OpenhomeError('too_large', `answer over ${Math.round(maxBytes / 1024)} KB`));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          if (!settled) {
            done();
            resolve({ status, text: decode(Buffer.concat(chunks, total)) });
          }
        });
        response.on('error', (err) => fail(networkError(err)));
        response.on('close', () => {
          if (!response.complete) {
            fail(new OpenhomeError('network', 'connection closed', { maybeSent: true }));
          }
        });
      },
    );
    request.on('error', (err) => fail(networkError(err)));
    request.end(payload, () => {
      written = true;
    });
  });
}

/**
 * UTF-8, or Latin-1 when the XML declaration says so (the description of a
 * Linn device declares ISO-8859-1). Only the first bytes are looked at.
 */
export function decode(buffer) {
  const head = buffer.subarray(0, 100).toString('latin1');
  return /^<\?xml[^>]*encoding=["']?(?:iso-8859-1|latin-?1|windows-1252)/i.test(head)
    ? buffer.toString('latin1')
    : buffer.toString('utf8');
}

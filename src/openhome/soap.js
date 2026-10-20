// -----------------------------------------------------------------------------
// UPnP control: one SOAP request per action (UPnP Device Architecture 1.1,
// section 3). A few lines of string building, no SOAP library: the envelope
// out, the out arguments in, the fault turned into an OpenhomeError.
// -----------------------------------------------------------------------------

import { LIMITS } from '../constants.js';
import { OpenhomeError } from './errors.js';
import { httpRequest } from './http.js';
import { childOf, childText, escapeXml, find, parseXml, textOf, XmlError } from './xml.js';

const ACTION_NAME = /^[A-Za-z][A-Za-z0-9]{0,40}$/;

/**
 * The SOAP envelope of an action. `args` keeps its insertion order: some
 * devices refuse arguments out of the SCPD order.
 */
export function buildEnvelope(serviceType, action, args = {}) {
  if (!ACTION_NAME.test(action)) {
    throw new OpenhomeError('refused', 'invalid action name');
  }
  const argsXml = Object.entries(args)
    .map(([name, value]) => {
      if (!ACTION_NAME.test(name)) {
        throw new OpenhomeError('refused', 'invalid argument name');
      }
      return `<${name}>${escapeXml(value)}</${name}>`;
    })
    .join('');
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"' +
    ' s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${action} xmlns:u="${escapeXml(serviceType)}">${argsXml}</u:${action}></s:Body>` +
    '</s:Envelope>'
  );
}

/**
 * The out arguments of an action response: a prototype-free `{ name: text }`.
 * Throws an OpenhomeError on a SOAP fault or an unusable answer.
 */
export function parseResponse(action, xml, status) {
  let envelope;
  try {
    envelope = parseXml(xml, { maxLength: LIMITS.soapBytes });
  } catch (err) {
    throw new OpenhomeError(
      'answer',
      `${action}: ${err instanceof XmlError ? err.message : 'invalid SOAP answer'}`,
      { status },
    );
  }
  const body = childOf(envelope, 'Body') ?? find(envelope, 'Body');
  const fault = find(body, 'Fault');
  if (fault) {
    const upnpError = find(fault, 'UPnPError');
    const code = childText(upnpError, 'errorCode') || undefined;
    const description = (
      childText(upnpError, 'errorDescription') ||
      childText(fault, 'faultstring') ||
      'fault'
    ).slice(0, 120);
    throw new OpenhomeError('fault', `${action} refused: ${code ? `${code} ` : ''}${description}`, {
      status,
      upnpCode: code,
    });
  }
  const response = (body?.children ?? []).find(
    (node) => typeof node === 'object' && node.name === `${action}Response`,
  );
  if (!response) {
    throw new OpenhomeError(
      status >= 400 ? 'status' : 'answer',
      `${action}: ${status >= 400 ? `HTTP ${status}` : 'no response element'}`,
      { status },
    );
  }
  const out = Object.create(null);
  for (const node of response.children) {
    if (typeof node === 'object' && !(node.name in out)) {
      out[node.name] = textOf(node);
    }
  }
  return out;
}

/** Call an action on a service control URL (a URL object) and resolve its out arguments. */
export async function soapCall({
  controlUrl,
  serviceType,
  action,
  args,
  timeout,
  signal,
  request,
}) {
  const send = request ?? httpRequest;
  const { status, text } = await send({
    url: controlUrl,
    body: buildEnvelope(serviceType, action, args),
    headers: {
      'Content-Type': 'text/xml; charset="utf-8"',
      SOAPACTION: `"${serviceType}#${action}"`,
    },
    timeout,
    maxBytes: LIMITS.soapBytes,
    signal,
  });
  return parseResponse(action, text, status);
}

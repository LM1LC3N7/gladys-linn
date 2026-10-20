// -----------------------------------------------------------------------------
// The error of a request to a device. `code`:
//   network   no TCP answer (refused, unreachable, reset)
//   timeout   no answer in time
//   aborted   cancelled by the integration (stop)
//   too_large the answer is over its size cap
//   redirect  the device answered 3xx (never followed)
//   status    HTTP status other than 200, without a SOAP fault (`status`)
//   fault     a SOAP fault (`upnpCode`, the message is its description)
//   answer    the XML is not what the request expects
//   refused   the integration refused to send (bad URL, other host)
//   deadline  not started: too little time left for what it belongs to
// Every error raised after an HTTP answer arrived (status, answer, too_large,
// redirect) has `maybeSent`: the device received the request.
// `unreachable` tells the failures that make a device "offline"; `maybeSent`
// says the request may have reached the device (a timeout after the request
// was written): a command is then "sent, without confirmation".
// Messages never quote an address: the caller names the device.
// -----------------------------------------------------------------------------

export class OpenhomeError extends Error {
  constructor(code, message, { status, upnpCode, maybeSent = false } = {}) {
    super(message);
    this.name = 'OpenhomeError';
    this.code = code;
    this.status = status;
    this.upnpCode = upnpCode;
    this.maybeSent = maybeSent;
  }

  get unreachable() {
    return this.code === 'network' || this.code === 'timeout';
  }
}

// -----------------------------------------------------------------------------
// A fake OpenHome device on the loopback interface: a UPnP description shaped
// after the one of a Linn DS (tests/data/linndescription.xml of
// openhomedevice), and the SOAP actions the integration uses, answered from
// an in-memory state. Every request is recorded (`calls`).
// -----------------------------------------------------------------------------

import http from 'node:http';

export const UDN = '4c494e4e-1234-ab12-abcd-01234567819f';

const SERVICE_LIST = {
  Product: 4,
  Volume: 4,
  Transport: 1,
  Info: 1,
  Playlist: 1,
  Radio: 2,
  Pins: 1,
};

export function description({ services = Object.keys(SERVICE_LIST), name = 'Kitchen' } = {}) {
  const list = services
    .map(
      (s) => `
         <service>
            <serviceType>urn:av-openhome-org:service:${s}:${SERVICE_LIST[s]}</serviceType>
            <serviceId>urn:av-openhome-org:serviceId:${s}</serviceId>
            <SCPDURL>/${UDN}/Upnp/av.openhome.org-${s}/service.xml</SCPDURL>
            <controlURL>/${UDN}/av.openhome.org-${s}/control</controlURL>
            <eventSubURL>/${UDN}/av.openhome.org-${s}/event</eventSubURL>
         </service>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="ISO-8859-1"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
   <specVersion><major>1</major><minor>0</minor></specVersion>
   <device>
      <deviceType>urn:linn-co-uk:device:Source:1</deviceType>
      <friendlyName>${name}</friendlyName>
      <manufacturer>Linn</manufacturer>
      <modelName>Majik DSM</modelName>
      <UDN>uuid:${UDN}</UDN>
      <serviceList>
         <service>
            <serviceType>urn:av-openhome-org:service:ConfigApp:1</serviceType>
            <serviceId>urn:av-openhome-org:serviceId:ConfigApp</serviceId>
            <controlURL>/${UDN}/av.openhome.org-ConfigApp-1/control</controlURL>
         </service>${list}
      </serviceList>
   </device>
</root>`;
}

const escape = (text) =>
  String(text).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
  );

export const SOURCE_XML =
  '<SourceList>' +
  '<Source><Name>Playlist</Name><Type>Playlist</Type><Visible>true</Visible></Source>' +
  '<Source><Name>Radio</Name><Type>Radio</Type><Visible>true</Visible></Source>' +
  '<Source><Name>UPnP AV</Name><Type>UpnpAv</Type><Visible>false</Visible></Source>' +
  '<Source><Name>TV</Name><Type>Hdmi</Type><Visible>true</Visible></Source>' +
  '</SourceList>';

export const TRACK =
  '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">' +
  '<item parentID="-1" restricted="1">' +
  '<upnp:artist xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">Beastie Boys</upnp:artist>' +
  '<upnp:artist role="AlbumArtist" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">Beastie Boys</upnp:artist>' +
  '<upnp:album xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">Ill Communication</upnp:album>' +
  '<dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">Sabotage</dc:title>' +
  '<res duration="0:02:58.000">http://192.168.1.38:9100/x.flac</res>' +
  '</item></DIDL-Lite>';

const bool = (v) => (v ? 'true' : 'false');

export function initialState() {
  return {
    standby: false,
    sourceIndex: 0,
    volume: 30,
    mute: false,
    transport: 'Playing',
    trackCount: 1,
    track: TRACK,
    metatext: '',
    pinSlots: [1, 2, 0, 3],
    pins: {
      1: { id: 1, title: 'FIP' },
      2: { id: 2, title: 'Playstation 4' },
      3: { id: 3, title: 'LP12' },
    },
  };
}

export async function startFakeDevice({ services, delays = {}, faults = {}, name } = {}) {
  const state = initialState();
  const calls = [];
  const handlers = {
    'Product#Standby': () => ({ Value: bool(state.standby) }),
    'Product#SetStandby': (args) => {
      state.standby = args.Value === '1' || args.Value === 'true';
    },
    'Product#SourceIndex': () => ({ Value: state.sourceIndex }),
    'Product#SetSourceIndex': (args) => {
      state.sourceIndex = Number(args.Value);
      state.standby = false;
    },
    'Product#SourceXml': () => ({ Value: SOURCE_XML }),
    'Volume#Volume': () => ({ Value: state.volume }),
    'Volume#SetVolume': (args) => {
      state.volume = Number(args.Value);
    },
    'Volume#Mute': () => ({ Value: bool(state.mute) }),
    'Volume#SetMute': (args) => {
      state.mute = args.Value === '1' || args.Value === 'true';
    },
    'Transport#TransportState': () => ({ State: state.transport }),
    'Transport#Play': () => {
      state.transport = 'Playing';
    },
    'Transport#Pause': () => {
      state.transport = 'Paused';
    },
    'Transport#Stop': () => {
      state.transport = 'Stopped';
    },
    'Transport#SkipNext': () => {
      state.trackCount += 1;
    },
    'Transport#SkipPrevious': () => {
      state.trackCount += 1;
    },
    'Playlist#TransportState': () => ({ Value: state.transport }),
    'Playlist#Play': () => {
      state.transport = 'Playing';
    },
    'Playlist#Pause': () => {
      state.transport = 'Paused';
    },
    'Playlist#Next': () => {
      state.trackCount += 1;
    },
    'Radio#TransportState': () => ({ Value: state.transport }),
    'Radio#Play': () => {
      state.transport = 'Playing';
    },
    'Radio#Pause': () => {
      state.transport = 'Paused';
    },
    'Info#Counters': () => ({ TrackCount: state.trackCount, DetailsCount: 1, MetatextCount: 1 }),
    'Info#Track': () => ({ Uri: 'x', Metadata: state.track }),
    'Info#Metatext': () => ({ Value: state.metatext }),
    'Pins#GetDeviceMax': () => ({ DeviceMax: state.pinSlots.length }),
    'Pins#GetIdArray': () => ({ IdArray: JSON.stringify(state.pinSlots) }),
    'Pins#ReadList': (args) => ({
      List: JSON.stringify(JSON.parse(args.Ids).map((id) => state.pins[id])),
    }),
    'Pins#InvokeIndex': (args) => {
      state.invokedPin = Number(args.Index);
      state.standby = false;
    },
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', async () => {
      if (req.method === 'GET') {
        calls.push('GET description');
        if (req.url === '/desc.xml') {
          res.writeHead(200, { 'Content-Type': 'text/xml' });
          res.end(description({ services, name }));
        } else {
          res.writeHead(404).end();
        }
        return;
      }
      const soapAction = String(req.headers.soapaction ?? '').replace(/"/g, '');
      const [type, action] = soapAction.split('#');
      const service = /service:([A-Za-z]+):/.exec(type)?.[1];
      const key = `${service}#${action}`;
      const args = {};
      for (const match of body.matchAll(/<([A-Za-z]+)>([^<]*)<\/\1>/g)) {
        args[match[1]] = match[2].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
      }
      calls.push(key);
      if (delays[key]) {
        await new Promise((resolve) => setTimeout(resolve, delays[key]));
      }
      if (faults[key] || !handlers[key]) {
        res.writeHead(500, { 'Content-Type': 'text/xml' });
        res.end(
          '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault>' +
            '<faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail>' +
            '<UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>401</errorCode>' +
            '<errorDescription>Invalid Action</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>',
        );
        return;
      }
      const out = handlers[key](args) ?? {};
      const outXml = Object.entries(out)
        .map(([k, v]) => `<${k}>${escape(v)}</${k}>`)
        .join('');
      res.writeHead(200, { 'Content-Type': 'text/xml; charset="utf-8"' });
      res.end(
        `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action}Response xmlns:u="${type}">${outXml}</u:${action}Response></s:Body></s:Envelope>`,
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    state,
    calls,
    location: `http://127.0.0.1:${port}/desc.xml`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

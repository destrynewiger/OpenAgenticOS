import { connect, getDb } from '../src/db.js';
import * as db from '../src/models.js';
import * as svc from '../src/service.js';

connect();

const buckets = [
  ['Current Incident Management / Likely Strong Fits', [
    ['LaunchDarkly', 'launchdarkly.com', 'FireHydrant'],
    ['Roblox', 'roblox.com', 'FireHydrant'],
    ['Coralogix', 'coralogix.com'],
    ['Panther Labs', 'panther.com'],
    ['Red Canary', 'redcanary.com'],
    ['Vectra AI', 'vectra.ai'],
    ['Imperva', 'imperva.com'],
    ['Tenable', 'tenable.com'],
    ['Fidelis Cybersecurity', 'fidelissecurity.com'],
    ['LogRhythm', 'logrhythm.com'],
    ['Tanium', 'tanium.com'],
    ['Verafin', 'verafin.com'],
    ['Infoblox', 'infoblox.com'],
  ]],
  ['Developer Infrastructure / Cloud / Data', [
    ['Astronomer', 'astronomer.io'],
    ['Airbyte', 'airbyte.com'],
    ['Cloudera', 'cloudera.com'],
    ['DataRobot', 'datarobot.com'],
    ['Mapbox', 'mapbox.com'],
    ['Sigma Computing', 'sigmacomputing.com'],
    ['Reltio', 'reltio.com'],
    ['Alation', 'alation.com'],
    ['Mendix', 'mendix.com'],
    ['Aurora Solar', 'aurorasolar.com'],
    ['Vantage Data Centers', 'vantage-dc.com'],
    ['EasyPost', 'easypost.com'],
  ]],
  ['High-Growth SaaS', [
    ['Asana', 'asana.com'],
    ['Demandbase', 'demandbase.com'],
    ['Highspot', 'highspot.com'],
    ['Pendo', 'pendo.io'],
    ['Medallia', 'medallia.com'],
    ['Optimizely', 'optimizely.com'],
    ['Zuora', 'zuora.com'],
    ['Coursera', 'coursera.org'],
    ['Quizlet', 'quizlet.com'],
    ['Kustomer', 'kustomer.com'],
    ['Sprout Social', 'sproutsocial.com'],
    ['Salesloft', 'salesloft.com'],
    ['Cvent', 'cvent.com'],
    ['ActionIQ', 'actioniq.com'],
    ['Funding Circle', 'fundingcircle.com'],
    ['Mailgun', 'mailgun.com'],
    ['Traveloka', 'traveloka.com'],
    ['Trainline', 'thetrainline.com'],
    ['HomeAdvisor', 'homeadvisor.com'],
    ['Shutterstock', 'shutterstock.com'],
    ['Brightcove', 'brightcove.com'],
  ]],
  ['Fintech / Payments / Crypto', [
    ['Paxos', 'paxos.com'],
    ['Binance', 'binance.com'],
    ['FalconX', 'falconx.io'],
    ['Ripple', 'ripple.com'],
    ['Kraken', 'kraken.com'],
    ['Oanda', 'oanda.com'],
    ['Trustly', 'trustly.com'],
    ['Tyro Payments', 'tyro.com'],
    ['mx51', 'mx51.io'],
    ['Tala', 'tala.co'],
    ['Pagaya', 'pagaya.com'],
    ['eToro', 'etoro.com'],
    ['Credible', 'credible.com'],
    ['Coincheck', 'coincheck.com'],
    ['ZipRecruiter', 'ziprecruiter.com'],
    ['Paylocity', 'paylocity.com'],
    ['Shift4', 'shift4.com'],
  ]],
  ['Consumer / Marketplace / Gaming', [
    ['Discord', 'discord.com'],
    ['Riot Games', 'riotgames.com'],
    ['Roku', 'roku.com'],
    ['SoundCloud', 'soundcloud.com'],
    ['Zwift', 'zwift.com'],
    ['OfferUp', 'offerup.com'],
    ['SYBO Games', 'sybogames.com'],
    ['StockX', 'stockx.com'],
    ['Match Group', 'match.com'],
  ]],
  ['Enterprise Software / Operations', [
    ['Manhattan Associates', 'manh.com'],
    ['ServiceMax', 'servicemax.com'],
    ['project44', 'project44.com'],
    ['Flexe', 'flexe.com'],
    ['Mark43', 'mark43.com'],
    ['Check Point Software', 'checkpoint.com'],
    ['Medidata', 'medidata.com'],
    ['Alkami', 'alkami.com'],
    ['Calix', 'calix.com'],
    ['Sportradar', 'sportradar.com'],
    ['Hotmart', 'hotmart.com'],
    ['Feedonomics', 'feedonomics.com'],
  ]],
  ['International / Large Digital Platforms', [
    ['PT GoTo (Gojek Tokopedia)', 'goto.com'],
    ['Angel One', 'angelone.in'],
    ['Flutterwave', 'flutterwave.com'],
    ['Telegraph Media Group', 'telegraph.co.uk'],
    ['Indeed Ireland Operations', 'indeed.com'],
  ]],
];

const priority1 = new Set([
  'LaunchDarkly', 'Roblox', 'Discord', 'Riot Games', 'Binance', 'Kraken',
  'Paxos', 'FalconX', 'Astronomer', 'Airbyte', 'Coralogix', 'Red Canary',
  'Vectra AI', 'DataRobot', 'Asana',
]);

const splashLogos = new Set([
  'LaunchDarkly', 'Roblox', 'Discord', 'Riot Games', 'Binance', 'Kraken',
  'Paxos', 'FalconX', 'Asana', 'Coursera', 'Roku', 'StockX', 'Mapbox',
  'Cloudera', 'DataRobot', 'Tenable', 'Tanium', 'Ripple', 'eToro',
  'ZipRecruiter', 'Paylocity', 'Shift4', 'Sprout Social', 'Salesloft',
  'Cvent', 'Medallia', 'Optimizely', 'Zuora', 'Traveloka', 'Trainline',
  'Shutterstock', 'Brightcove', 'Flutterwave', 'Indeed Ireland Operations',
]);

function signalExists(accountId, kind, label) {
  return !!getDb().prepare(`SELECT 1 FROM signals WHERE account_id = ? AND kind = ? AND label = ? LIMIT 1`).get(accountId, kind, label);
}

function techExists(accountId, tool) {
  return !!getDb().prepare(`SELECT 1 FROM tech_stack WHERE account_id = ? AND lower(tool) = lower(?) LIMIT 1`).get(accountId, tool);
}

function addSignalOnce(accountId, signal) {
  if (!signalExists(accountId, signal.kind, signal.label)) db.addSignal(accountId, signal);
}

function addTechOnce(accountId, tech) {
  if (!techExists(accountId, tech.tool)) db.addTech(accountId, tech);
}

let created = 0;
let updated = 0;
for (const [bucket, rows] of buckets) {
  for (const [name, domain, incidentTool] of rows) {
    const p1 = priority1.has(name);
    const notes = [
      `Outreach bucket: ${bucket}`,
      p1 ? 'Imported priority: Priority 1' : 'Imported priority: Planned outreach',
      'Source: user-provided planned outreach list / pasted GTM thread',
    ].join('\n');
    const { account, created: wasCreated } = db.upsertAccount({
      name,
      domain,
      website: domain ? `https://${domain}` : '',
      incident_stack: incidentTool || '',
      notes,
    });
    wasCreated ? created++ : updated++;
    db.updateAccount(account.id, {
      notes: account.notes?.includes('Outreach bucket:')
        ? account.notes
        : [account.notes, notes].filter(Boolean).join('\n\n'),
      incident_stack: incidentTool || account.incident_stack || '',
    });
    addSignalOnce(account.id, {
      kind: 'planned_outreach',
      label: 'Planned outreach',
      detail: bucket,
      source: 'user planned account list',
      confidence: 90,
    });
    if (p1) {
      addSignalOnce(account.id, {
        kind: 'source_priority',
        label: 'Priority 1',
        detail: 'User-selected start-here account for planned outreach.',
        source: 'user planned account list',
        confidence: 100,
      });
    }
    if (splashLogos.has(name)) {
      addSignalOnce(account.id, {
        kind: 'splash_logo',
        label: 'Splash logo',
        detail: 'Recognizable logo for JJ review. Verify current fit, contact, and timing before sequencing.',
        source: 'operator JJ lens',
        confidence: 92,
      });
    }
    if (/Current Incident Management/.test(bucket)) {
      addSignalOnce(account.id, {
        kind: 'incident_stack',
        label: incidentTool ? `${incidentTool} mentioned` : 'Incident-management fit',
        detail: incidentTool ? `User list says currently on ${incidentTool}.` : 'Bucketed as current incident management / likely strong fit.',
        source: 'user planned account list',
        confidence: incidentTool ? 95 : 75,
      });
    }
    if (incidentTool) {
      addTechOnce(account.id, {
        tool: incidentTool,
        category: 'incident',
        source: 'user planned account list',
        confidence: 95,
      });
    }
    svc.rescoreAccount(account.id);
  }
}

console.log(JSON.stringify({ created, updated, totalSeeded: buckets.reduce((n, [, rows]) => n + rows.length, 0) }, null, 2));

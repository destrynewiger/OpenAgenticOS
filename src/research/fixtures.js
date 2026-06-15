// Local sample research, keyed by domain. IMPORTANT: every company here is
// FICTIONAL (.example domains, 555-01xx phones, .example emails) so the demo is
// rich without asserting anything false about a real business. When you import
// your real target list, the adapters return honest "needs research" for unknown
// domains until Sumble / web / LLM are wired. Treat all of this as illustrative.

export const FIXTURES = {
  'quanta-cloud.example': {
    rootly_customer: 'no',
    pagerduty_customer: 'yes',
    incident_stack: 'Slack, PagerDuty, Datadog, Terraform, Kubernetes',
    tech: [
      { tool: 'PagerDuty', category: 'incident' },
      { tool: 'Slack', category: 'chatops' },
      { tool: 'Datadog', category: 'observability' },
      { tool: 'Kubernetes', category: 'cloud' },
      { tool: 'Terraform', category: 'cloud' },
    ],
    status_page: { url: 'https://status.quanta-cloud.example', provider: 'BetterStack', last_incident: 'Elevated API latency (resolved)' },
    signals: [
      { kind: 'infra_scaling', label: 'Scaling multi-region platform', detail: 'Hiring SREs + platform engineers across 3 regions', confidence: 80 },
      { kind: 'ai_initiative', label: 'Launching AI inference platform', detail: 'New GPU/inference product line', confidence: 75 },
      { kind: 'outage', label: 'Recent reliability event', detail: 'API latency incident on status page', confidence: 70 },
    ],
    quotes: [{
      quote: 'Reliability and uptime are foundational to our platform commitments to customers',
      source_name: 'Sample (illustrative — replace with sourced quote)', source_date: '2025',
      interpretation: 'Platform scaling plus AI infra usually means more on-call load and more customer-impacting failure modes — exactly where incident response gets expensive.',
    }],
    contacts: [
      { name: 'Priya Raman', title: 'Site Reliability Engineer', email: 'priya.raman@quanta-cloud.example', phone: '+1-555-0142', linkedin: 'https://linkedin.com/in/sample-priya-raman' },
      { name: 'Marcus Lee', title: 'SRE Manager', email: 'marcus.lee@quanta-cloud.example', phone: '+1-555-0143' },
      { name: 'Dana Whitfield', title: 'Director of Platform Engineering', email: 'dana.whitfield@quanta-cloud.example', phone: '+1-555-0144', linkedin: 'https://linkedin.com/in/sample-dana-whitfield' },
      { name: 'Sam Okafor', title: 'VP Engineering', email: 'sam.okafor@quanta-cloud.example' },
      { name: 'Lena Cho', title: 'CTO', linkedin: 'https://linkedin.com/in/sample-lena-cho' },
    ],
  },

  'northwind-logistics.example': {
    rootly_customer: 'no',
    pagerduty_customer: 'yes',
    incident_stack: 'Slack, PagerDuty, ServiceNow, Datadog, Grafana',
    tech: [
      { tool: 'PagerDuty', category: 'incident' },
      { tool: 'ServiceNow', category: 'itsm' },
      { tool: 'Slack', category: 'chatops' },
      { tool: 'Datadog', category: 'observability' },
      { tool: 'Grafana', category: 'observability' },
    ],
    status_page: { url: 'https://status.northwind-logistics.example', provider: 'Atlassian Statuspage', last_incident: 'Tracking API degraded performance (resolved)' },
    signals: [
      { kind: 'outage', label: 'Status-page incident in last 30 days', detail: 'Tracking API degraded performance', confidence: 75 },
      { kind: 'infra_scaling', label: 'Warehouse automation rollout', detail: 'Expanding real-time tracking + automation', confidence: 70 },
    ],
    quotes: [{
      quote: 'Real-time visibility and supply-chain uptime are central to customer trust',
      source_name: 'Sample (illustrative — replace with sourced quote)', source_date: '2025',
      interpretation: 'More real-time logistics surface area means more customer-impacting incidents and tighter comms requirements during outages.',
    }],
    contacts: [
      { name: 'Jordan Pike', title: 'On-call Engineer', email: 'jordan.pike@northwind-logistics.example', phone: '+1-555-0151' },
      { name: 'Aisha Bello', title: 'Engineering Manager', email: 'aisha.bello@northwind-logistics.example' },
      { name: 'Tom Reyes', title: 'Director of Infrastructure', email: 'tom.reyes@northwind-logistics.example', phone: '+1-555-0152', linkedin: 'https://linkedin.com/in/sample-tom-reyes' },
    ],
  },

  'helios-payments.example': {
    rootly_customer: 'unknown',
    pagerduty_customer: 'yes',
    incident_stack: 'Slack, PagerDuty, Jira, New Relic, AWS',
    tech: [
      { tool: 'PagerDuty', category: 'incident' },
      { tool: 'New Relic', category: 'observability' },
      { tool: 'Slack', category: 'chatops' },
      { tool: 'Jira', category: 'itsm' },
    ],
    status_page: { url: 'https://status.helios-payments.example', provider: 'incident.io', last_incident: '' },
    signals: [
      { kind: 'new_to_role', label: 'New VP of Engineering (last 90 days)', detail: 'Likely re-evaluating reliability tooling', confidence: 70 },
      { kind: 'eval', label: 'Possible incident-tooling evaluation', detail: 'Job posts mention "modernize incident response"', confidence: 55 },
    ],
    quotes: [{
      quote: 'Payment availability and incident transparency are core to regulatory and customer commitments',
      source_name: 'Sample (illustrative — replace with sourced quote)', source_date: '2025',
      interpretation: 'Payments + compliance means downtime is expensive and incident comms are scrutinized — a strong fit for structured incident response.',
    }],
    contacts: [
      { name: 'Wei Zhang', title: 'Senior SRE', email: 'wei.zhang@helios-payments.example', phone: '+1-555-0161' },
      { name: 'Olivia Grant', title: 'VP Engineering', email: 'olivia.grant@helios-payments.example', linkedin: 'https://linkedin.com/in/sample-olivia-grant' },
    ],
  },

  'vega-streaming.example': {
    rootly_customer: 'unknown',
    pagerduty_customer: 'unknown',
    incident_stack: 'Slack, Opsgenie, Grafana, Prometheus',
    tech: [
      { tool: 'Opsgenie', category: 'incident' },
      { tool: 'Grafana', category: 'observability' },
      { tool: 'Prometheus', category: 'observability' },
      { tool: 'Slack', category: 'chatops' },
    ],
    status_page: { url: 'https://status.vega-streaming.example', provider: 'Instatus', last_incident: '' },
    signals: [
      { kind: 'ai_initiative', label: 'AI-driven recommendations launch', detail: 'New ML personalization platform', confidence: 65 },
    ],
    // Intentionally NO contacts → demonstrates the "missing contact data" path.
    contacts: [],
  },

  'acme-retail.example': {
    rootly_customer: 'no',
    pagerduty_customer: 'yes',
    incident_stack: 'Slack, PagerDuty, ServiceNow, Splunk, Kubernetes',
    tech: [
      { tool: 'PagerDuty', category: 'incident' },
      { tool: 'ServiceNow', category: 'itsm' },
      { tool: 'Splunk', category: 'observability' },
      { tool: 'Kubernetes', category: 'cloud' },
      { tool: 'Slack', category: 'chatops' },
    ],
    status_page: { url: 'https://status.acme-retail.example', provider: 'custom', last_incident: 'Checkout latency during peak (resolved)' },
    signals: [
      { kind: 'outage', label: 'Peak-traffic checkout incident', detail: 'Latency during sale event', confidence: 72 },
      { kind: 'infra_scaling', label: 'Store + checkout tech expansion', detail: 'Scaling digital checkout footprint', confidence: 75 },
      { kind: 'filing_quote', label: 'Reliability cited in annual report', confidence: 60 },
    ],
    quotes: [{
      quote: 'Expansion of our digital checkout and store technology footprint remains a strategic priority',
      source_name: 'Sample (illustrative — replace with sourced quote)', source_date: '2025 annual report',
      interpretation: 'More digital retail surface area usually means more incident coordination, more on-call pressure, and more customer-impacting failure modes.',
    }],
    contacts: [
      { name: 'Ravi Menon', title: 'Site Reliability Engineer', email: 'ravi.menon@acme-retail.example', phone: '+1-555-0171' },
      { name: 'Beth Carlson', title: 'Platform Manager', email: 'beth.carlson@acme-retail.example' },
      { name: 'Hugo Strand', title: 'Director of Engineering', email: 'hugo.strand@acme-retail.example', phone: '+1-555-0172', linkedin: 'https://linkedin.com/in/sample-hugo-strand' },
      { name: 'Mei Tan', title: 'CIO', email: 'mei.tan@acme-retail.example' },
    ],
  },
};

export function fixtureFor(domain) {
  if (!domain) return null;
  return FIXTURES[String(domain).toLowerCase()] || null;
}

import type { Business, Channel, Member, Message, PlanCardData } from './types';

/** Mock scenario: creator "Maya" launching a focus app, "Rune". Phase-1 demo data. */

export const businesses: Business[] = [
  { id: 'rune', name: 'Rune', mark: 'R', accent: 'var(--teal-500)' },
  { id: 'atlas', name: 'Atlas Studio', mark: 'A', accent: 'var(--coral-500)' },
  { id: 'field', name: 'Field Notes', mark: 'F', accent: '#7a5cff' },
];

export const members: Member[] = [
  {
    id: 'you',
    name: 'Maya',
    handle: 'maya',
    role: 'you',
    presence: 'online',
    initials: 'MA',
  },
  {
    id: 'agent',
    name: 'Octopus',
    handle: 'octopus',
    role: 'agent',
    presence: 'online',
    initials: 'OC',
    activity: 'Drafting your growth plan',
  },
  {
    id: 'node-lena',
    name: 'Lena Ortiz',
    handle: 'lena.creative',
    role: 'pro',
    presence: 'idle',
    initials: 'LO',
    activity: 'Creative director · joins for briefs',
  },
];

export const channels: Channel[] = [
  { id: 'brief', name: 'brief', section: 'Overview', kind: 'text' },
  { id: 'strategy', name: 'strategy', section: 'Plan', kind: 'text' },
  { id: 'content', name: 'content', section: 'Plan', kind: 'text', unread: 2 },
  { id: 'ads', name: 'paid-ads', section: 'Channels', kind: 'text' },
  { id: 'seo', name: 'seo', section: 'Channels', kind: 'text' },
  { id: 'email', name: 'email', section: 'Channels', kind: 'text' },
  { id: 'measure', name: 'measurement', section: 'Channels', kind: 'text' },
  { id: 'launch-topic', name: 'launch — week 1', section: 'Topics', kind: 'topic' },
];

export const plan: PlanCardData = {
  title: 'Get Rune to its first 1,000 paying users',
  goal: 'Launch + full-funnel growth for a $6/mo focus app · budget ceiling $1,500/mo',
  estCost: '$1,180 / mo',
  estTimeline: '~6 weeks to first cohort',
  verified: 'sources verified within 5 days',
  stages: [
    {
      id: 's1',
      title: 'Positioning & offer',
      detail: 'Sharpen the "focus, not another to-do list" angle; 14-day trial, annual discount.',
      owner: 'AI',
    },
    {
      id: 's2',
      title: 'Content engine',
      detail: '3 short-form videos/wk + 2 SEO articles on deep-work workflows.',
      owner: 'AI',
      metric: '20 assets / mo',
    },
    {
      id: 's3',
      title: 'Creative direction',
      detail: 'Art-direct the hero ad set + brand kit — routed to a human creative node.',
      owner: 'HUMAN',
      metric: 'Lena Ortiz',
    },
    {
      id: 's4',
      title: 'Paid acquisition',
      detail: 'Meta Advantage+ test across 4 hooks; scale winners; strict CPA ceiling.',
      owner: 'AI',
      metric: '$400 test',
    },
    {
      id: 's5',
      title: 'Connect ad accounts',
      detail: 'Authorize Meta & Google — you approve; nothing spends without your sign-off.',
      owner: 'YOU',
    },
    {
      id: 's6',
      title: 'Measure & iterate',
      detail: 'Track trial→paid, CAC and ROAS weekly; reallocate budget to winners.',
      owner: 'AI',
    },
  ],
  citations: [
    {
      id: 'c1',
      label: 'Meta Advantage+ creative best practices',
      source: 'meta ads help',
      verified: '3 days ago',
    },
    {
      id: 'c2',
      label: 'SaaS trial→paid conversion benchmarks',
      source: 'octopus outcomes',
      verified: '5 days ago',
    },
    {
      id: 'c3',
      label: 'FTC endorsement / disclosure guidance',
      source: 'ftc.gov',
      verified: '4 days ago',
    },
  ],
};

export const seedMessages: Message[] = [
  {
    id: 'm0',
    authorId: 'system',
    kind: 'system',
    body: 'Maya started the project “Grow Rune”.',
    ts: '09:12',
  },
  {
    id: 'm1',
    authorId: 'you',
    kind: 'text',
    body: 'launch and grow my focus app Rune — get me to my first 1,000 paying users. budget is about $1,500/mo.',
    ts: '09:12',
  },
  {
    id: 'm2',
    authorId: 'agent',
    kind: 'text',
    body: 'On it. I pulled what’s worked for comparable indie SaaS launches and drafted a full-funnel plan — grounded and cited. Humans step in only for creative direction and account access. Here it is:',
    ts: '09:13',
  },
  {
    id: 'm3',
    authorId: 'agent',
    kind: 'plan',
    plan,
    ts: '09:13',
    planState: 'pending',
  },
];

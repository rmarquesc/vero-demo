/**
 * Sample feed for the demo. The content is invented; what is real is the
 * verification state, which comes from the ledger.
 *
 * A post's identity is the SHA-256 of its `content` string, so these strings
 * are what get verified — change one and its badge disappears, which is the
 * behaviour you want from a content-bound signal.
 */
export type Post = {
  id: string;
  name: string;
  handle: string;
  content: string;
};

export const POSTS: Post[] = [
  {
    id: 'p1',
    name: 'Marta Ferreira',
    handle: '@mferreira',
    content:
      'Health authority confirms the seasonal vaccination programme opens on 15 October, ' +
      'with priority for over-65s and immunocompromised patients.',
  },
  {
    id: 'p2',
    name: 'anon_eth',
    handle: '@anon_eth',
    content:
      'Audited three bridge contracts this month. Two share the same unchecked ' +
      'withdrawal path. Writing it up before anyone loses money.',
  },
  {
    id: 'p3',
    name: 'Diário Regional',
    handle: '@diarioregional',
    content:
      'Municipal budget documents obtained this week show a 12% increase in ' +
      'infrastructure spending, concentrated in two districts.',
  },
  {
    id: 'p4',
    name: 'wellness_daily',
    handle: '@wellness_daily',
    content:
      'Sunlight at noon and daily meditation can reverse most chronic conditions. ' +
      'Doctors will not tell you this.',
  },
];

import { GroupPreferences, Preferences } from './models';

type Member = { uid: string; name: string; preferences: Partial<Preferences> };

const PACE_ORDER = ['relaxed', 'balanced', 'packed'] as const;
const LEVEL_ORDER = ['low', 'medium', 'high'] as const;

const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; }; 
const fromMin = (n: number) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;

// Picks the most conservative value present, so nobody gets overworked
function mostConservative<T extends string>(values: (T | undefined)[], order: readonly T[]): T | undefined {
  const present = values.filter((v): v is T => !!v);
  return order.find(o => present.includes(o));
}

// Combines every member's preferences into one set the LLM plans against, and lists disagreements
export function mergeGroupPreferences(members: Member[], overrides: Partial<Preferences> = {}): GroupPreferences {
  const conflicts: GroupPreferences['conflicts'] = [];
  const prefs = members.map(m => m.preferences);

  // Dietary: union, so everyone can eat everywhere
  const dietary = [...new Set(prefs.flatMap(p => p.dietary ?? []))];

  // Budget: lowest budget is the cap; it also flags a big range
  const withBudget = members.filter(m => m.preferences.budgetPerDay != null);
  const budgets = withBudget.map(m => m.preferences.budgetPerDay!);
  const budgetPerDay = budgets.length ? Math.min(...budgets) : undefined;
  if (budgets.length > 1 && Math.max(...budgets) > budgetPerDay! * 1.5) {
    const low = withBudget.find(m => m.preferences.budgetPerDay === budgetPerDay)!;
    conflicts.push({ field: 'budgetPerDay', message: `Budgets range $${budgetPerDay}–$${Math.max(...budgets)}/day; using ${low.name}'s $${budgetPerDay}.` });
  }

  // Active hours: the overlap everyone is awake for
  const hours = prefs.map(p => p.activeHours).filter((h): h is { start: string; end: string } => !!h);
  let activeHours: Preferences['activeHours'];
  if (hours.length) {
    const start = Math.max(...hours.map(h => toMin(h.start)));
    const end = Math.min(...hours.map(h => toMin(h.end)));
    if (start < end) activeHours = { start: fromMin(start), end: fromMin(end) };
    else conflicts.push({ field: 'activeHours', message: 'Members\' active hours don\'t overlap.' });
  }

  // Interests: ordered by how many members share them
  const counts = new Map<string, number>();
  prefs.flatMap(p => p.interests ?? []).forEach(i => counts.set(i, (counts.get(i) ?? 0) + 1));
  const interests = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([i]) => i);

  // Pace and activity level: most conservative is chosen and flag disagreement with names
  const pace = mostConservative(prefs.map(p => p.pace), PACE_ORDER);
  if (new Set(prefs.map(p => p.pace).filter(Boolean)).size > 1) {
    conflicts.push({ field: 'pace', message: `Different pace: ${members.map(m => `${m.name} (${m.preferences.pace ?? '—'})`).join(', ')}.` });
  }
  const activityLevel = mostConservative(prefs.map(p => p.activityLevel), LEVEL_ORDER);
  if (new Set(prefs.map(p => p.activityLevel).filter(Boolean)).size > 1) {
    conflicts.push({ field: 'activityLevel', message: `Different activity levels: ${members.map(m => `${m.name} (${m.preferences.activityLevel ?? '—'})`).join(', ')}.` });
  }

  // Per-trip overrides win over the computed values
  const merged: Preferences = { budgetPerDay, activeHours, dietary, interests, pace, activityLevel, ...overrides };
  return {
    members: members.map(m => ({ uid: m.uid, name: m.name, preferences: { interests: [], dietary: [], ...m.preferences } })),
    merged,
    conflicts,
  };
}
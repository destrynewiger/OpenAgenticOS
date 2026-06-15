import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPersona, buildTeamMap, pickFirstContact } from '../src/personas.js';

const cases = [
  ['Site Reliability Engineer', 'end_user', 'SRE'],
  ['Senior SRE', 'end_user', 'SRE'],
  ['SRE Manager', 'manager', 'SRE Manager'],
  ['Platform Engineer', 'end_user', 'Platform Engineer'],
  ['DevOps Manager', 'manager', 'DevOps Manager'],
  ['Engineering Manager', 'manager', 'Engineering Manager'],
  ['Incident Commander', 'end_user', 'Incident Commander'],
  ['On-call Engineer', 'end_user', 'On-call Engineer'],
  ['Director of Platform Engineering', 'decision_maker', 'Director of Engineering'],
  ['VP Engineering', 'decision_maker', 'VP Engineering'],
  ['CTO', 'department_head', 'CTO'],
  ['Head of Engineering', 'department_head', 'Head of Engineering'],
];

for (const [title, level, role] of cases) {
  test(`classifies "${title}" → ${level} / ${role}`, () => {
    const p = classifyPersona(title);
    assert.equal(p.level, level);
    assert.equal(p.role, role);
  });
}

test('manager titles never misclassify as end_user', () => {
  assert.equal(classifyPersona('SRE Manager').level, 'manager');
  assert.equal(classifyPersona('Platform Manager').level, 'manager');
});

test('unknown titles are not force-fit to a level', () => {
  const p = classifyPersona('Chief Marketing Officer');
  assert.notEqual(p.level, 'end_user');
});

test('team map caps contacts per level and groups correctly', () => {
  const contacts = [
    { name: 'A', persona_level: 'end_user', confidence: 90 },
    { name: 'B', persona_level: 'end_user', confidence: 80 },
    { name: 'C', persona_level: 'end_user', confidence: 70 },
    { name: 'D', persona_level: 'decision_maker', confidence: 60 },
  ];
  const map = buildTeamMap(contacts, 2);
  assert.equal(map.end_user.length, 2); // capped
  assert.equal(map.decision_maker.length, 1);
  assert.equal(map.end_user[0].name, 'A'); // highest confidence first
});

test('first contact prefers a decision maker', () => {
  const c = pickFirstContact([
    { name: 'IC', persona_level: 'end_user', confidence: 95 },
    { name: 'Dir', persona_level: 'decision_maker', confidence: 50 },
  ]);
  assert.equal(c.name, 'Dir');
});

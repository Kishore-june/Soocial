// Test des echeances du "Ne pas deranger". Logique pure, aucun prerequis :
//   node test/dnd.mjs

import { computeUntil, isActive, MORNING_HOUR } from '../dnd.js';

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures++;
}

const now = new Date(2026, 7, 23, 14, 30).getTime(); // un dimanche, 14 h 30

check('off -> 0', computeUntil('off', now) === 0);
check('choix inconnu -> 0', computeUntil('demain', now) === 0);
check('on -> -1 (indefini)', computeUntil('on', now) === -1);
check('30 -> maintenant + 30 min', computeUntil('30', now) === now + 30 * 60 * 1000);
check('60 -> maintenant + 1 h', computeUntil('60', now) === now + 60 * 60 * 1000);

// "Demain matin" depuis l'apres-midi : le lendemain a l'heure du matin.
{
  const until = new Date(computeUntil('morning', now));
  check(
    'morning depuis 14 h 30 -> lendemain',
    until.getDate() === 24 && until.getHours() === MORNING_HOUR && until.getMinutes() === 0,
    until.toString()
  );
}

// Depuis 6 h du matin, le prochain matin est CE matin, pas dans 24 h.
{
  const dawn = new Date(2026, 7, 23, 6, 0).getTime();
  const until = new Date(computeUntil('morning', dawn));
  check(
    'morning depuis 6 h -> 8 h le jour meme',
    until.getDate() === 23 && until.getHours() === MORNING_HOUR,
    until.toString()
  );
}

// Pile a l'heure du matin, on vise le lendemain : une echeance a l'instant
// present serait deja passee.
{
  const eight = new Date(2026, 7, 23, MORNING_HOUR, 0).getTime();
  check('morning depuis 8 h pile -> lendemain', new Date(computeUntil('morning', eight)).getDate() === 24);
}

check('until 0 -> inactif', !isActive(0, now));
check('until -1 -> actif', isActive(-1, now));
check('echeance future -> actif', isActive(now + 1000, now));
check('echeance passee -> inactif', !isActive(now - 1000, now));
check("echeance = maintenant -> inactif", !isActive(now, now));

process.exit(failures ? 1 : 0);

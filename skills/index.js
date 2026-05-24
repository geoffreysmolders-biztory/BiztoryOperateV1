// Sub-skill registry — single import surface for server.js
import { gapScannerSkill } from './gap-scanner.js';
import { methodologyWalkerSkill } from './methodology-walker.js';
import { aiReadinessScanSkill } from './ai-readiness-scan.js';
import { digitalWorkforceScopingSkill } from './digital-workforce-scoping.js';

export const SKILLS = {
  [gapScannerSkill.name]: gapScannerSkill,
  [methodologyWalkerSkill.name]: methodologyWalkerSkill,
  [aiReadinessScanSkill.name]: aiReadinessScanSkill,
  [digitalWorkforceScopingSkill.name]: digitalWorkforceScopingSkill,
};

export const DEFAULT_SKILL = 'gap-scanner';

export function getSkill(name) {
  return SKILLS[name] || SKILLS[DEFAULT_SKILL];
}

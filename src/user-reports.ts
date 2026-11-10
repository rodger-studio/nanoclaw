/**
 * Auto-triage for the user-reports Slack channel.
 *
 * Every top-level message posted there by an app/bot (Clutch feedback,
 * Debatium suggestions, support emails…) gets a synthetic trigger injected
 * into its thread, so the agent investigates and drafts an answer right away —
 * exactly what a human does today by typing "@agent check" in the thread.
 *
 * Clutch posts a user's follow-up messages (replies to support, repeat
 * reports) as replies in that user's open thread. Those are triaged too, and
 * Célian and Guillaume are pinged unless one of them already follows it.
 *
 * Smash (smash.rodgerstudio.com, repo rodger-studio/smash) posts the bug
 * reports of its team (« Signaler à Guillaume ») here too: those get a Smash
 * triage that reads the smash repo instead of the app user tools.
 */

export interface ReportCandidate {
  channel: string;
  ts: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  /** The message's own `text` (the notification fallback, not the block text). */
  text?: string;
}

export type UserReportKind = 'new' | 'follow-up' | 'smash-bug';

/** Slack user ids of the people to ping on urgent reports and on follow-ups (Célian, Guillaume). */
export const REPORT_OWNER_IDS = ['U09ULJQ2C86', 'U0AA6SD1PCG'];

export const REPORT_OWNERS_MENTION = REPORT_OWNER_IDS.map(
  (id) => `<@${id}>`,
).join(' ');

/**
 * Whether one of the owners already follows a thread: then they get the
 * follow-up notification and nobody needs a ping. Slack has no API for a
 * thread's followers, but it subscribes whoever replies in a thread or is
 * @mentioned in it.
 */
export function ownerFollowsThread(
  messages: { user?: string; text?: string }[],
): boolean {
  return REPORT_OWNER_IDS.some((id) =>
    messages.some((m) => m.user === id || (m.text ?? '').includes(`<@${id}>`)),
  );
}

// Fallback text of a feedback post (`:envelope: Contact — Clutch: …`, built by
// @rodger/feedback). Tells a user's follow-up apart from the other bot replies
// in a report thread, such as "✉️ Réponse envoyée à l'utilisateur".
const FEEDBACK_POST = /^:(bug|bulb|envelope|wave): [^\n—]+ — /;
// First line of a Smash bug report (BUG_REPORT_HEADER in the smash repo,
// src/server/agent/bug-reports.ts): `:bug: *Bug Smash signalé par …*`.
const SMASH_BUG_POST = /^:bug: \*Bug Smash signalé par /;

export function userReportKind(
  msg: ReportCandidate,
  reportsChannelId: string | undefined,
  botUserId: string | undefined,
): UserReportKind | null {
  if (!reportsChannelId || msg.channel !== reportsChannelId) return null;
  if (!msg.bot_id && msg.subtype !== 'bot_message') return null;
  // Never triage our own posts (e.g. the daily "User Report Manager" message)
  if (botUserId && msg.user === botUserId) return null;
  if (!msg.thread_ts || msg.thread_ts === msg.ts) {
    return SMASH_BUG_POST.test(msg.text ?? '') ? 'smash-bug' : 'new';
  }
  return FEEDBACK_POST.test(msg.text ?? '') ? 'follow-up' : null;
}

export const USER_REPORT_PROMPT = `[Auto-triage] Nouveau report utilisateur ci-dessus. Prépare le travail pour l'équipe, comme si on t'avait tagué avec "check".

1. Enquête avec tous tes outils : fiche PostHog (lien/ID dans le report), user ID et données du compte (création, parrainage, statut, bans, multi-comptes/devices), marché concerné et sa résolution, rédemptions/récompenses, code du repo si c'est un bug, threads similaires précédents.
2. N'effectue AUCUNE action : pas de ban/unban, remboursement, changement de résolution, PR, ni message envoyé à l'utilisateur. Tu prépares, l'équipe décide.
3. Réponds dans ce thread avec :
   • une ligne de verdict en gras ;
   • les constats clés avec preuves (IDs, dates, valeurs), concis ;
   • un brouillon de réponse prêt à envoyer, dans la langue de l'utilisateur, ton court et amical (tutoiement), comme nos réponses habituelles.
4. S'il manque une info ou si une décision humaine est nécessaire (ex. débannir, rembourser), dis exactement ce qu'il faut et propose les options avec ta recommandation, plutôt qu'un brouillon définitif.
5. Pour une simple suggestion produit : courte évaluation (pertinence, existant, effort) et brouillon de remerciement bref.
6. Si le report semble urgent (incident touchant plusieurs utilisateurs, app/paiements/récompenses cassés, perte d'argent ou de données, problème légal ou de sécurité, utilisateur à qui il faut répondre vite), commence ta réponse par "🚨 Urgent" et mentionne directement Célian et Guillaume en écrivant exactement ${REPORT_OWNERS_MENTION} (syntaxe de mention Slack, pas "@Célian"). Sinon, ne mentionne personne.`;

export const USER_REPORT_FOLLOWUP_PROMPT = `[Auto-triage] L'utilisateur vient de relancer dans ce fil (dernier message du bot ci-dessus). Célian et Guillaume sont déjà notifiés : ne les mentionne pas.

1. Relis tout le fil : le report d'origine, ton analyse précédente, les réponses déjà envoyées à l'utilisateur ("Réponse envoyée à l'utilisateur") et les échanges de l'équipe.
2. Dis ce qui est nouveau dans cette relance (info en plus, problème non résolu, nouveau sujet, simple remerciement) et vérifie avec tes outils ce qui a changé depuis (statut de la rédemption, résolution du marché, compte…).
3. N'effectue AUCUNE action : pas de ban/unban, remboursement, changement de résolution, PR, ni message envoyé à l'utilisateur. Tu prépares, l'équipe décide.
4. Réponds dans ce fil avec une ligne de verdict en gras, les constats clés avec preuves, et un brouillon de réponse dans la langue de l'utilisateur, ton court et amical (tutoiement). Si c'est juste un remerciement sans question, dis-le en une ligne : aucune réponse nécessaire.
5. Si la relance est urgente (mêmes critères que pour un nouveau report), commence ta réponse par "🚨 Urgent".`;

export const SMASH_BUG_PROMPT = `[Auto-triage] Nouveau bug Smash ci-dessus, signalé par un membre de l'équipe depuis Smash (smash.rodgerstudio.com, l'outil interne de créas publicitaires et son Agent). Ce n'est pas un report d'utilisateur d'une app : pas de PostHog, pas de brouillon de réponse.

1. Clone le code : \`git clone https://x-access-token:$GITHUB_TOKEN@github.com/rodger-studio/smash.git\`. Lis \`AGENTS.md\` (architecture : smash-web, smash-worker, smash-agent, Postgres), puis le code qui touche l'erreur du run (\`src/server/jobs/agent/\` pour l'Agent, \`patches/\` pour le harness TanStack patché). Regarde aussi les derniers commits de main et le changelog de \`docs/plans/smash-v2.md\` : le bug est peut-être déjà corrigé ou déjà connu.
2. Pars des faits du report : le run, son erreur exacte, son message, les derniers runs (un run qui a échoué puis un run qui a réussi n'est pas le même cas qu'une conversation bloquée).
3. N'effectue AUCUNE action : pas de PR, pas de commit, pas d'écriture en base, pas de message ailleurs. Tu prépares, Guillaume décide.
4. Réponds dans ce fil avec :
   • une ligne de verdict en gras (bug connu et corrigé, bug à corriger, erreur ponctuelle d'un fournisseur, mauvaise utilisation…) ;
   • la cause probable, avec les preuves (fichier:ligne, commit, message d'erreur) ;
   • le correctif proposé (où et quoi changer), et s'il faut débloquer la conversation à la main ;
   • ce que tu n'as pas pu vérifier (la base et les logs de Smash ne te sont pas accessibles).
5. Guillaume est déjà mentionné dans le report : ne le mentionne pas. Si le bug bloque toute l'équipe (Smash ou l'Agent cassé pour tous), commence ta réponse par "🚨 Urgent".`;

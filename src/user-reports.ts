/**
 * Auto-triage for the user-reports Slack channel.
 *
 * Every top-level message posted there by an app/bot (Clutch feedback,
 * Debatium suggestions, support emails…) gets a synthetic trigger injected
 * into its thread, so the agent investigates and drafts an answer right away —
 * exactly what a human does today by typing "@agent check" in the thread.
 */

export interface ReportCandidate {
  channel: string;
  ts: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
}

export function isUserReport(
  msg: ReportCandidate,
  reportsChannelId: string | undefined,
  botUserId: string | undefined,
): boolean {
  if (!reportsChannelId || msg.channel !== reportsChannelId) return false;
  // Top-level only: replies (e.g. "Réponse envoyée à l'utilisateur") are skipped
  if (msg.thread_ts && msg.thread_ts !== msg.ts) return false;
  if (!msg.bot_id && msg.subtype !== 'bot_message') return false;
  // Never triage our own posts (e.g. the daily "User Report Manager" message)
  if (botUserId && msg.user === botUserId) return false;
  return true;
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
6. Si le report semble urgent (incident touchant plusieurs utilisateurs, app/paiements/récompenses cassés, perte d'argent ou de données, problème légal ou de sécurité, utilisateur à qui il faut répondre vite), commence ta réponse par "🚨 Urgent" et mentionne directement Célian et Guillaume en écrivant exactement <@U09ULJQ2C86> <@U0AA6SD1PCG> (syntaxe de mention Slack, pas "@Célian"). Sinon, ne mentionne personne.`;

# Déployer Companion iOS sur TestFlight

L’application mobile est maintenant native SwiftUI dans `apps/ios`. Le client Expo,
EAS Build et EAS Update ont été retirés. Le client actuel sait restaurer
une session, s’authentifier par e-mail ou Google, afficher les Companions et utiliser leur fil de
discussion avec l’API `/v1` partagée. La livraison TestFlight utilise GitHub Actions et la même
identité App Store Connect que l’ancien client.

Les builds TestFlight Expo déjà installés restent utilisables chez les testeurs, mais ils ne
reçoivent plus de mise à jour. Il n’existe plus de mécanisme OTA ni de voie de secours EAS.

## Identité conservée

- bundle id Release : `dev.companion.mobile` ;
- bundle id Debug : `dev.companion.mobile.dev` ;
- équipe Apple : `K28B69CWQ7` ;
- fiche App Store Connect : `6804447784`, « Companion (623507) » ;
- nom affiché : `Companion (623507)` ;
- nom de bundle : `Companion623507` ;
- version marketing native initiale : `2.0.0`.

Les valeurs Release sont définies dans `apps/ios/Config/Release.xcconfig` et ne doivent pas être
surchargées par un argument de lancement. L’API de production reste épinglée à
`https://api.thecompanion.sh`.

## Pipeline natif

`apps/ios/scripts/release.sh` archive l’app Release, applique un numéro de build UTC à la seconde, signe
avec l’équipe Apple puis exporte avec `destination=upload`. L’export envoie le build à App Store
Connect mais ne le soumet jamais à la revue App Store.

`.github/workflows/ios-testflight.yml` exécute cette commande sur `macos-15` :

- automatiquement lorsqu’un changement `apps/ios/**` arrive sur `main` ;
- manuellement avec `gh workflow run ios-testflight.yml --ref main`.

Le job utilise l’environnement GitHub protégé `ios-testflight` et ses secrets `ASC_KEY_ID`,
`ASC_ISSUER_ID`, `ASC_KEY_P8`, `IOS_DISTRIBUTION_P12`,
`IOS_DISTRIBUTION_P12_PASSWORD` et `IOS_PROVISIONING_PROFILE`. Le certificat et le profil sont
installés dans un trousseau temporaire du runner puis supprimés. Sa concurrence est sérialisée afin
que deux archives ne soient pas envoyées simultanément avec des numéros de build concurrents.

Avant la première livraison, configurer également `GOOGLE_CLIENT_ID` et `GOOGLE_CLIENT_SECRET` sur
l’API publique. Vérifier dans la console Google que l’URL de rappel Better Auth de production est
autorisée, puis réaliser une connexion Google complète depuis un build Release. Les tests mockés
valident le contrat de redirection côté client, mais ne valident pas la configuration du fournisseur.

Le numéro de build est produit avec `date -u +%Y%m%d%H%M%S`, puis fourni à Xcode par
`CURRENT_PROJECT_VERSION`. Cette valeur évite les collisions entre relances rapprochées et ne dépend
d’aucun état EAS.

Une livraison locale autorisée utilise la clé depuis un chemin externe au dépôt :

```bash
ASC_KEY_ID="<key-id>" \
ASC_ISSUER_ID="<issuer-id>" \
ASC_KEY_PATH="/secure/path/AuthKey_<key-id>.p8" \
IOS_PROVISIONING_PROFILE_SPECIFIER="Companion Native App Store 2026-08-24" \
bash apps/ios/scripts/release.sh
```

## Vérification locale actuelle

```bash
xcodebuildmcp swift-package test --package-path apps/ios/CompanionKit
xcodebuildmcp simulator build \
  --workspace-path apps/ios/Companion.xcworkspace \
  --scheme Companion \
  --simulator-name "<simulateur disponible>" \
  --extra-args CODE_SIGNING_ALLOWED=NO
```

Le workflow `iOS E2E` exécute ce smoke test manuellement ou chaque lundi depuis `main`. Son
environnement GitHub `ios-e2e` fournit `COMPANION_IOS_E2E_API_URL`,
`COMPANION_IOS_E2E_EMAIL` et `COMPANION_IOS_E2E_PASSWORD`; les clés Box et Z.ai restent des secrets
du dépôt. Le job démarre une stack et une base éphémères, seed le compte local, connecte Z.ai, crée
un Companion temporaire, envoie un message avec `CompanionKit`, attend une nouvelle réponse
corrélée, puis supprime le Companion et son Box avant d’arrêter la stack. Il ne s’exécute jamais sur
une pull request et refuse toute URL d’API qui ne cible pas explicitement la boucle locale, afin de
ne jamais contacter la base de production.

Après un upload accepté, attendre la fin du traitement Apple puis vérifier le nouveau build dans la
fiche `6804447784`. Les groupes et testeurs restent gérés dans App Store Connect.

# Déployer Companion iOS sur TestFlight

L’application mobile est en cours de migration vers SwiftUI natif dans `apps/ios`. Le client Expo,
EAS Build et EAS Update ont été retirés au début de la migration. Jusqu’à la livraison du jalon
TestFlight natif, ce dépôt contient un squelette iOS vérifiable mais aucun pipeline de livraison
mobile utilisable.

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

## État transitoire de la migration

Après le merge du squelette natif, déconnecter manuellement l’intégration Expo↔GitHub dans le
dashboard Expo. Sans cette action, les pushs sur `main` peuvent encore tenter de lancer un workflow
EAS dont les fichiers n’existent plus.

Ne pas tenter une nouvelle livraison mobile avant que les deux éléments suivants soient présents et
validés :

- `apps/ios/scripts/release.sh`, qui archive puis exporte avec `xcodebuild` et une clé App Store
  Connect ;
- `.github/workflows/ios-testflight.yml`, qui exécute cette commande sur macOS et utilise les
  secrets `ASC_KEY_ID`, `ASC_ISSUER_ID` et `ASC_KEY_P8`.

Le futur numéro de build sera produit avec `date -u +%Y%m%d%H%M`, puis fourni à Xcode par
`CURRENT_PROJECT_VERSION`. Cette valeur est monotone à la minute et ne dépend d’aucun état EAS.

## Vérification locale actuelle

```bash
xcodebuildmcp swift-package test --package-path apps/ios/CompanionKit
xcodebuildmcp simulator build \
  --workspace-path apps/ios/Companion.xcworkspace \
  --scheme Companion \
  --simulator-name "<simulateur disponible>" \
  --extra-args CODE_SIGNING_ALLOWED=NO
```

La procédure d’archive, d’upload et de gestion des testeurs sera complétée avec le jalon TestFlight
natif. Les testeurs restent gérés dans App Store Connect.

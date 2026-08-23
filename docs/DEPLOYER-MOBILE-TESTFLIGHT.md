# Déployer Companion mobile sur TestFlight

L’application Expo autonome vit dans `apps/mobile`. Toutes les commandes EAS partent de la racine
avec `pnpm mobile:eas …` : ce wrapper force la variante `production`, utilise la version exacte
d’EAS CLI verrouillée dans le lockfile mobile et empêche la création accidentelle de l’identifiant
local `dev.companion.mobile.dev` dans App Store Connect.

## Configuration initiale

Le projet utilise :

- l’organisation Expo `the-vibe-company` ;
- l’identifiant iOS de production `dev.companion.mobile` ;
- l’équipe Apple `K28B69CWQ7` ;
- l’environnement EAS `production`, où `EXPO_PUBLIC_API_URL` vaut
  `https://api.thecompanion.sh`.

Les certificats iOS et la clé App Store Connect sont gérés par EAS et ne sont jamais versionnés.
La fiche App Store Connect porte l’identifiant `6804447784`, reporté dans
`submit.production.ios.ascAppId` de `apps/mobile/eas.json`. Sans cet identifiant, une soumission non
interactive peut échouer après le build. Apple ayant refusé le nom global déjà pris « Companion »,
la fiche initiale a été créée sous « Companion (623507) » ; le nom public peut être remplacé dans
App Store Connect quand un nom disponible est choisi, sans changer le nom affiché sous l’icône.

`apps/mobile/pnpm-workspace.yaml` est volontairement présent même si l’application est exclue du
workspace racine. EAS lance `pnpm install` sans l’option locale `--ignore-workspace` ; ce fichier
garantit alors que le cloud utilise `apps/mobile/pnpm-lock.yaml` et trouve bien Expo.

## Première livraison

```bash
pnpm mobile:release:test
pnpm mobile:eas workflow:validate .eas/workflows/testflight.yml --non-interactive
pnpm mobile:eas build --platform ios --profile production --auto-submit
```

Apple peut demander une connexion ou un code 2FA lors de la première configuration des
identifiants. Une fois le build traité, gérer les testeurs et les informations de bêta dans App
Store Connect > TestFlight.

## Livraisons suivantes

Le workflow `.eas/workflows/testflight.yml` se déclenche sur `main` une fois GitHub relié au projet
Expo avec `apps/mobile` comme répertoire de base. Il calcule l’empreinte native :

- nouvelle empreinte : build iOS puis soumission TestFlight ;
- empreinte déjà construite : mise à jour EAS compatible, sans reconstruire le binaire.

Commandes utiles :

```bash
pnpm mobile:eas build:list --platform ios
pnpm mobile:eas update:list --branch production
pnpm mobile:eas workflow:run .eas/workflows/testflight.yml
```

Pour revenir sur une mise à jour JavaScript, utiliser `pnpm mobile:eas update:republish --branch
production`. Un binaire TestFlight se retire depuis App Store Connect.

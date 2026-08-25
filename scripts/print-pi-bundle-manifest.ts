/**
 * Print the pinned Pi bundle manifest as shell-eval assignments, so `scripts/build-pi-bundle.sh`
 * builds exactly the versions declared in `packages/box-runtime/src/piBundle.ts` — the single source
 * of truth for the bundle pins. The `npm:` prefixes Pi and npm both understand are stripped where a
 * plain npm/pi argument is expected.
 */
import {
  COMPANION_PI_BUNDLE,
  COMPANION_PI_NPM_PACKAGE,
  companionPiBundleObjectKey,
} from "../packages/box-runtime/src/index";

const stripNpm = (spec: string): string => spec.replace(/^npm:/, "");

const lines = [
  `PI_BUNDLE_PI_PACKAGE='${COMPANION_PI_NPM_PACKAGE}@${COMPANION_PI_BUNDLE.piVersion}'`,
  `PI_BUNDLE_EXTENSIONS='${COMPANION_PI_BUNDLE.packages.join(" ")}'`,
  `PI_BUNDLE_QMD_PACKAGE='${stripNpm(COMPANION_PI_BUNDLE.qmdPackage)}'`,
  `PI_BUNDLE_NODE_MAJOR='${COMPANION_PI_BUNDLE.nodeMajor}'`,
  `PI_BUNDLE_FORMAT='${COMPANION_PI_BUNDLE.bundleFormat}'`,
  `PI_BUNDLE_OBJECT_KEY='${companionPiBundleObjectKey(COMPANION_PI_BUNDLE.sha256)}'`,
];

process.stdout.write(`${lines.join("\n")}\n`);

const { withXcodeProject } = require("expo/config-plugins");

/**
 * Expo's "[Expo] Configure project" script phase lists *.entitlements as an
 * output, so automatic signing can rewrite the file while Xcode is codesigning.
 * That trips: "Entitlements file was modified during the build".
 */
module.exports = function withIosCodeSignEntitlementsModification(config) {
  return withXcodeProject(config, (nextConfig) => {
    const project = nextConfig.modResults;
    const configurations = project.pbxXCBuildConfigurationSection();

    for (const key of Object.keys(configurations)) {
      const buildSettings = configurations[key]?.buildSettings;
      if (!buildSettings || typeof buildSettings !== "object") {
        continue;
      }
      if (buildSettings.CODE_SIGN_ENTITLEMENTS) {
        buildSettings.CODE_SIGN_ALLOW_ENTITLEMENTS_MODIFICATION = "YES";
      }
    }

    return nextConfig;
  });
};

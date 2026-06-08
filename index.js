const appConstructorRules = require("./app-constructor-rules");

module.exports = {
  sc_plugin_api_version: 1,
  plugin_name: "many-to-many",
  viewtemplates: [require("./checkboxes")],
  ready_for_mobile: true,
  app_constructor_rules: appConstructorRules.join("\n"),
};

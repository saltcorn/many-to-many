const {
  span,
  button,
  i,
  a,
  script,
  domReady,
  di,
  h3,
  select,
  option,
  div,
  input,
  label,
  style,
} = require("@saltcorn/markup/tags");
const View = require("@saltcorn/data/models/view");
const Workflow = require("@saltcorn/data/models/workflow");
const Table = require("@saltcorn/data/models/table");
const Form = require("@saltcorn/data/models/form");
const Field = require("@saltcorn/data/models/field");
const {
  jsexprToWhere,
  eval_expression,
} = require("@saltcorn/data/models/expression");

const db = require("@saltcorn/data/db");
const {
  stateFieldsToWhere,
  picked_fields_to_query,
} = require("@saltcorn/data/plugin-helper");
const { features } = require("@saltcorn/data/db/state");

const configuration_workflow = () =>
  new Workflow({
    steps: [
      {
        name: "Many-to-many relation",
        form: async (context) => {
          const table = await Table.findOne({ id: context.table_id });
          const mytable = table;
          const fields = await table.getFields();
          const { child_field_list, child_relations } =
            await table.get_child_relations();
          var agg_field_opts = [];

          for (const { table, key_field } of child_relations) {
            const keyFields = table.fields.filter(
              (f) =>
                f.type === "Key" && !["_sc_files"].includes(f.reftable_name)
            );
            for (const kf of keyFields) {
              const joined_table = await Table.findOne({
                name: kf.reftable_name,
              });
              if (!joined_table) continue;
              await joined_table.getFields();
              joined_table.fields.forEach((jf) => {
                agg_field_opts.push({
                  label: `${table.name}.${key_field.name}&#8594;${kf.name}&#8594;${jf.name}`,
                  name: `${table.name}.${key_field.name}.${kf.name}.${jf.name}`,
                });
              });
            }
          }
          return new Form({
            blurb: "Choose the relation that will be edited",
            fields: [
              {
                name: "relation",
                label: "Relation",
                type: "String",
                sublabel:
                  "Only many-to-many relations (JoinTable.foreignKey&#8594;keyToTableWithLabels&#8594;LabelField) are supported ",

                required: true,
                attributes: {
                  options: agg_field_opts,
                },
              },
              {
                name: "maxHeight",
                label: "max-height px",
                type: "Integer",
              },
              {
                name: "where",
                label: "Where",
                type: "String",
                class: "validate-expression",
              },
              {
                name: "groupby",
                label: "Group by",
                type: "String",
                sublabel: "Formula",
                class: "validate-expression",
              },
              {
                name: "field_values_formula",
                label: "Row values formula",
                class: "validate-expression",
                sublabel:
                  "Optional. A formula for field values set when creating a new join table row. For example <code>{name: manager}</code>",
                type: "String",
                fieldview: "textarea",
              },
            ],
          });
        },
      },
    ],
  });
const get_state_fields = async (table_id, viewname, { columns }) => [
  {
    name: "id",
    type: "Integer",
    required: true,
  },
];

const run = async (
  table_id,
  viewname,
  { relation, maxHeight, where, groupby },
  state,
  extra
) => {
  const { id } = state;
  if (!id) return "need id";
  const req = extra.req;

  if (!relation) {
    throw new Error(
      `Select2 many-to-many view ${viewname} incorrectly configured. No relation chosen`
    );
  }
  const relSplit = relation.split(".");
  if (relSplit.length < 4) {
    throw new Error(
      `Select2 many-to-many view ${viewname} incorrectly configured. No relation chosen`
    );
  }
  const rndid = `bs${Math.round(Math.random() * 100000)}`;
  const [relTableNm, relField, joinFieldNm, valField] = relSplit;
  const table = await Table.findOne({ id: table_id });

  const relTable = await Table.findOne({ name: relTableNm });
  await relTable.getFields();
  const joinField = relTable.fields.find((f) => f.name === joinFieldNm);
  const joinedTable = await Table.findOne({ name: joinField.reftable_name });
  const rows = await table.getJoinedRows({
    where: { id },
    forPublic: !req.user || req.user.role_id === 100, // TODO in mobile set user null for public
    forUser: req.user,
    aggregations: {
      _selected: {
        table: joinField.reftable_name,
        ref: "id",
        subselect: {
          field: joinFieldNm,
          table: { name: db.sqlsanitize(relTable.name) }, //legacy, workaround insufficient escape
          whereField: relField,
        },
        field: valField,
        aggregate: "ARRAY_AGG",
      },
    },
  });
  if (!rows[0]) return "No row selected";

  const selected = new Set(rows[0]._selected || []);
  const checkbox = (p) =>
    div(
      { class: "form-check" },
      input({
        class: "form-check-input",
        type: "checkbox",
        onchange: `view_post('${viewname}', this.checked ? 'add': 'remove', {id:'${id}', value: '${p}'})`,
        checked: selected.has(p),
      }),
      label({ class: "form-check-label" }, p)
    );

  if (!groupby) {
    const possibles = await joinedTable.distinctValues(
      valField,
      where
        ? jsexprToWhere(
            where,
            { ...rows[0], user: req.user },
            joinedTable.getFields()
          )
        : undefined
    );

    return div(possibles.map(checkbox));
  } else {
    const allRows = await joinedTable.getRows(
      where
        ? jsexprToWhere(
            where,
            { ...rows[0], user: req.user },
            joinedTable.getFields()
          )
        : {}
    );
    const groups = {};
    for (const row of allRows) {
      const group = eval_expression(groupby, row);
      if (!groups[group]) groups[group] = [];
      groups[group].push(row[valField]);
    }
    return div(
      Object.entries(groups).map(([group, vals]) =>
        div(h3(group), vals.map(checkbox))
      )
    );
  }
};

const remove = async (table_id, viewname, { relation }, { id, value }) => {
  const relSplit = relation.split(".");
  const [joinTableNm, relField, joinFieldNm, valField] = relSplit;
  const joinTable = await Table.findOne({ name: joinTableNm });
  await joinTable.getFields();
  const joinField = joinTable.fields.find((f) => f.name === joinFieldNm);
  const schema = db.getTenantSchema();
  await db.query(
    `delete from "${schema}"."${db.sqlsanitize(joinTable.name)}" 
      where "${db.sqlsanitize(relField)}"=$1 and 
      "${db.sqlsanitize(joinFieldNm)}" in 
      (select id from 
        "${schema}"."${db.sqlsanitize(joinField.reftable_name)}" 
        where "${db.sqlsanitize(valField)}"=$2)`,
    [id, value]
  );
  return { json: { success: "ok" } };
};
const add = async (
  table_id,
  viewname,
  { relation, field_values_formula },
  { id, value },
  { req }
) => {
  const table = await Table.findOne({ id: table_id });
  const rows = await table.getJoinedRows({
    where: { id },
    forPublic: !req.user || req.user.role_id === 100, // TODO in mobile set user null for public
    forUser: req.user,
  });
  if (!rows[0]) return { json: { error: "Row not found" } };
  let extra = {};
  if (field_values_formula) {
    extra = eval_expression(field_values_formula, rows[0], req.user);
  }
  const relSplit = relation.split(".");
  const [joinTableNm, relField, joinFieldNm, valField] = relSplit;
  const joinTable = await Table.findOne({ name: joinTableNm });
  await joinTable.getFields();
  const joinField = joinTable.fields.find((f) => f.name === joinFieldNm);
  const joinedTable = await Table.findOne({ name: joinField.reftable_name });
  const joinedRow = await joinedTable.getRow({ [valField]: value });
  await joinTable.insertRow({
    [relField]: id,
    [joinFieldNm]: joinedRow.id,
    ...extra,
  });
  return { json: { success: "ok" } };
};

module.exports = {
  name: "Checkboxes many-to-many",
  display_state_form: false,
  get_state_fields,
  configuration_workflow,
  run,
  routes: { remove, add },
};

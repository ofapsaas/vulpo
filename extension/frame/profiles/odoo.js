// profiles/odoo.js — fb-020-005-odoo-form-validity (§3.7).
// Capa de producto: ÚNICO lugar del mecanismo donde viven los literales de
// Odoo (firma de raíz del webclient, clases de invalidez, atributo de campo).
// El núcleo (`serializer.js`, `validity-profiles.js`) no conoce estos
// literales — los recibe como dato inyectado (§3.1, I-1/I-2).
//
// `detect` opera sobre el DOM (nunca la URL, §3.1): la raíz del webclient de
// Odoo 19 es `.o_web_client`, presente en cualquier despliegue.
//
// Marcadores de invalidez medidos en campo (S-F13 de fb-020-004, formulario de
// gastos con requeridos vacíos, 2026-09-17): `o_field_invalid` en el widget de
// un campo de formulario, `o_invalid_cell` en una celda de lista editable.
// `fieldNameAttribute: 'name'` — el atributo `name` del widget de campo trae
// el nombre técnico del campo en Odoo.
export const odooValidityProfile = {
  id: 'odoo',
  detect: (doc) => !!doc.querySelector('.o_web_client'),
  invalidMarkerSelector: '.o_field_invalid, .o_invalid_cell',
  fieldNameAttribute: 'name',
};

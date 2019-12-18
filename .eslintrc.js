// https://eslint.org/docs/user-guide/configuring

module.exports = {
  root: true,
  env: {
    browser: false,
    es6: true,
    node: true,
    jest: true,
  },
  extends: ['standard'],
  // add your custom rules here
  rules: {
    'prefer-promise-reject-errors': [0, {"allowEmptyReject": true}],
    "curly": [0, "multi-or-nest"],
    "semi": [2, "always"],
    // allow async-await
    'generator-star-spacing': 'off',
    // allow debugger during development
    'no-debugger': process.env.NODE_ENV === 'production' ? 'error' : 'off',
    // turn off because we need for postgress - other options to be discussed
    "camelcase": 0,
    "no-unused-vars": ["warn"],
    // id rather this be...
    // "comma-dangle": ["error", "always"]
    // (always dangle)
    // but this will allow both...
    // - being able to comma dangle means you can do things like
    //   comment props in objects and not have to fix commas etc
    "comma-dangle": ["error", {
      "arrays": "ignore",
      "objects": "ignore",
      "imports": "ignore",
      "exports": "ignore",
      "functions": "ignore"
    }]
  }
};
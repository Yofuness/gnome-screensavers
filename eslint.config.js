// SPDX-License-Identifier: CC0-1.0
// SPDX-FileCopyrightText: No rights reserved
// GNOME's recommended ESLint setup for GJS / GNOME Shell extensions
// (https://gjs.guide/guides/gjs/style-guide.html).

import js from '@eslint/js';
export default [
    js.configs.recommended,
    {
        languageOptions: {
            globals: {ARGV:'readonly',Debugger:'readonly',GIRepositoryGType:'readonly',globalThis:'readonly',imports:'readonly',Intl:'readonly',log:'readonly',logError:'readonly',pkg:'readonly',print:'readonly',printerr:'readonly',window:'readonly',TextEncoder:'readonly',TextDecoder:'readonly',console:'readonly',setTimeout:'readonly',setInterval:'readonly',clearTimeout:'readonly',clearInterval:'readonly',global:'readonly',_:'readonly',C_:'readonly',N_:'readonly',ngettext:'readonly'},
            parserOptions: {ecmaVersion: 2022, sourceType: 'module'},
        },
        rules: {
            'array-callback-return':'error','no-await-in-loop':'error','no-constant-binary-expression':'error','no-constructor-return':'error','no-new-native-nonconstructor':'error','no-promise-executor-return':'error','no-self-compare':'error','no-template-curly-in-string':'error','no-unmodified-loop-condition':'error','no-unreachable-loop':'error','no-unused-private-class-members':'error',
            'no-use-before-define':['error',{functions:false,classes:true,variables:true,allowNamedExports:true}],
            'block-scoped-var':'error','complexity':'warn','consistent-return':'error','default-param-last':'error','eqeqeq':'error','no-array-constructor':'error','no-caller':'error','no-extend-native':'error','no-extra-bind':'error','no-extra-label':'error','no-iterator':'error','no-label-var':'error','no-loop-func':'error','no-multi-assign':'warn','no-new-object':'error','no-new-wrappers':'error','no-proto':'error','no-shadow':'warn',
            'no-unused-vars':['error',{varsIgnorePattern:'^_',argsIgnorePattern:'^_'}],'no-var':'warn','unicode-bom':'error',
            'no-restricted-globals':['error',{name:'Debugger',message:'Internal use only'},{name:'GIRepositoryGType',message:'Internal use only'},{name:'log',message:'Use console.log()'},{name:'logError',message:'Use console.warn() or console.error()'}],
        },
    },
];

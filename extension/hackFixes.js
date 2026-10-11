// SPDX-License-Identifier: GPL-2.0-or-later
// Corrections and additions to a hack's own option list (from its XScreenSaver
// config), by hack name.  Each entry may have:
//   options(list) -> the corrected option list
//   args(values)  -> extra command-line arguments built from several options
// Options may carry `when: values => bool` to show them only in some cases;
// options without an `arg` are handled by args().  Plain JavaScript: used by
// both the shell and the preferences window.

// Vermiculate is driven by a small command language ("instring", originally
// recorded key presses).  With no instring it plays one of its built-in
// patterns at random, and that pattern's own speed replaces --speed, which is
// why the drawing speed only takes effect with a chosen style.  Its config
// also calls --speed "Duration" (higher draws faster), and doesn't offer the
// pattern length, which the hack reads from its "ticks" resource.
const VERMICULATE_PATTERNS = [
    ['circuit', 'Circuit board', 'AEBMN222222223#CAR9CAD4CAOV'],
    ['orbits', 'Orbiting chasers', 'mn333#c23#f1#]]]]]]]]]]]3bc9#r9#c78#f9#ma4#'],
    ['angles', 'Right angles', 'AEBMN22222#CAD4CAORc1#f2#c1#r6'],
    ['menagerie', 'Menagerie', 'aebmnrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr#'],
    ['followers', 'Little followers', 'mn6rrrrrrrrrrrrrrr#by1i#lcalc1#fnyav'],
    ['swarm', 'Swarm', 'mn1rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr#by1i#lcalc1#fn'],
    ['bouncing', 'Bouncing circles', 'baeMn333333333333333333333333#CerrYerCal'],
    ['streets', 'City streets', 'baeMn1111111111111111111111111111111111111111111111111111111111#Cer9YesYevYerCal'],
    ['families', 'Families', 'baMn111111222222333333444444555555#Ct1#lCt2#lCt3#lCt4#lCt5#lCerrYerYet'],
    ['families-short', 'Families, short tails',
        'baMn111111222222333333444444555555#Ct1#lCt2#lCt3#lCt4#lCt5#lCerrYerYetYt1i#lYt1i#sYt1#v'],
];

const MOVEMENTS = [
    ['r', 'Mixed'],
    ['1', 'Wobbly'],
    ['2', 'Straight runs'],
    ['3', 'Circles'],
    ['4', 'Spirals'],
    ['5', 'Zig-zag arcs'],
    ['6', 'Arcs and straights'],
    ['7', 'Wiggles'],
];

const isCustom = values => values.style === 'custom';

/** The instring for the Custom style's options. */
export function vermiculateInstring(values) {
    const worms = Math.max(1, Math.min(120, Math.round(values.worms)));
    let s = '';
    if (!values.erase)
        s += 'e';                       // erasing is on by default: E keeps trails
    if (values.cycle)
        s += 'a';                       // autopalette
    if (!values.border)
        s += 'b';                       // the border is on by default
    s += `mn${values.movement.repeat(worms)}#`;
    if (values.maze)
        s += 'g#';
    if (values.maze && values.breakWalls)
        s += 'yek';                     // all threads: kill walls
    if (values.short)
        s += 'yel';                     // all threads: little (short trails)
    if (values.bounce)
        s += 'yer';                     // all threads: real bounce
    if (values.chase)
        s += 'cel';                     // all threads: each chases the next
    return s;
}

function vermiculateOptions(list) {
    const style = {
        type: 'select', id: 'style', label: 'Style', default: 'random',
        choices: [
            {id: 'random', label: 'Random', arg: ''},
            ...VERMICULATE_PATTERNS.map(([id, label]) => ({id, label, arg: ''})),
            {id: 'custom', label: 'Custom', arg: ''},
            {id: 'instring', label: 'Your own instring', arg: ''},
        ],
    };
    const custom = [
        {type: 'number', id: 'worms', label: 'Worms', lowLabel: 'Few', highLabel: 'Many',
            low: 1, high: 60, default: 8, spin: true},
        {type: 'select', id: 'movement', label: 'Movement', default: 'r',
            choices: MOVEMENTS.map(([id, label]) => ({id, label, arg: ''}))},
        {type: 'boolean', id: 'maze', label: 'Maze grid', default: false},
        {type: 'boolean', id: 'breakWalls', label: 'Worms break through the maze', default: false,
            when: values => isCustom(values) && values.maze},
        {type: 'boolean', id: 'erase', label: 'Erase old trail behind each worm', default: true},
        {type: 'boolean', id: 'short', label: 'Short worms', default: false},
        {type: 'boolean', id: 'chase', label: 'Each worm chases the next', default: false},
        {type: 'boolean', id: 'bounce', label: 'Worms bounce off trails', default: false},
        {type: 'boolean', id: 'cycle', label: 'Cycling colours', default: false},
        {type: 'boolean', id: 'border', label: 'Coloured border', default: true},
    ].map(o => ({when: isCustom, ...o}));
    const instring = {
        type: 'string', id: 'instring', label: 'Instring (Vermiculate command language)', default: '',
        when: values => values.style === 'instring',
    };

    const speed = list.find(o => o.id === 'speed');
    return [
        style,
        {
            ...speed, arg: undefined, label: 'Drawing speed', lowLabel: 'Slow', highLabel: 'Fast',
            default: 300, when: values => values.style !== 'random',
        },
        {
            type: 'number', id: 'ticks', label: 'Pattern length', lowLabel: 'Short', highLabel: 'Long',
            low: 5000, high: 200000, default: 20000, arg: '-xrm *ticks:%', invert: false, spin: false,
        },
        ...custom,
        instring,
        ...list.filter(o => o.id !== 'speed'),
    ];
}

function vermiculateArgs(values) {
    let instring = null;
    const pattern = VERMICULATE_PATTERNS.find(([id]) => id === values.style);
    if (pattern)
        instring = pattern[2];
    else if (values.style === 'custom')
        instring = vermiculateInstring(values);
    else if (values.style === 'instring' && values.instring.trim())
        instring = values.instring.trim();
    // Random: no instring, so the hack picks a pattern and its speed.
    return instring ? ['--instring', instring, '--speed', String(Math.round(values.speed))] : [];
}

export const HACK_FIXES = {
    vermiculate: {options: vermiculateOptions, args: vermiculateArgs},
};

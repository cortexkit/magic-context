//! The memory mural's bitmap font, converted from the standalone plugin's
//! `mural-font.generated.ts` so both render the same pixels. Every glyph is
//! a 5x8 cell drawn one row per byte, the high bit of the five on the left.

// Spleen 5x8 bitmap data is Copyright (c) 2018-2026, Frederic Cambus.
// All rights reserved. Spleen is distributed under the BSD-2-Clause license:
//
//   Redistribution and use in source and binary forms, with or without
//   modification, are permitted provided that the following conditions are met:
//   * Redistributions of source code must retain the above copyright notice,
//     this list of conditions and the following disclaimer.
//   * Redistributions in binary form must reproduce the above copyright notice,
//     this list of conditions and the following disclaimer in the documentation
//     and/or other materials provided with the distribution.
//   THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
//   AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
//   IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
//   ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
//   LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
//   CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
//   SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
//   INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
//   CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
//   ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
//   POSSIBILITY OF SUCH DAMAGE.
//
// The Spleen font supplies printable ASCII and U+2500; the additional mural
// cue marks use deterministic 5x8 companion patterns because they are not
// mapped by the Spleen 5x8 OTB.
//
// Source: pxpipe/assets/Spleen-5x8.otb

/// Glyph width and advance, in pixels.
pub const CELL_WIDTH: usize = 5;
/// Glyph height, in pixels.
pub const CELL_HEIGHT: usize = 8;
/// Distance between text rows, in pixels.
pub const LINE_PITCH: usize = 9;

/// The glyphs, sorted by character for binary search.
const GLYPHS: [(char, [u8; 8]); 107] = [
    (' ', [0, 0, 0, 0, 0, 0, 0, 0]),
    ('!', [4, 4, 4, 4, 4, 0, 4, 0]),
    ('"', [10, 10, 10, 0, 0, 0, 0, 0]),
    ('#', [0, 10, 31, 10, 10, 31, 10, 0]),
    ('$', [4, 14, 20, 12, 6, 6, 28, 4]),
    ('%', [2, 18, 20, 4, 8, 10, 18, 16]),
    ('&', [4, 10, 10, 12, 21, 18, 13, 0]),
    ('\'', [4, 4, 4, 0, 0, 0, 0, 0]),
    ('(', [2, 4, 8, 8, 8, 8, 4, 2]),
    (')', [8, 4, 2, 2, 2, 2, 4, 8]),
    ('*', [0, 0, 18, 12, 30, 12, 18, 0]),
    ('+', [0, 0, 4, 4, 31, 4, 4, 0]),
    (',', [0, 0, 0, 0, 0, 4, 4, 8]),
    ('-', [0, 0, 0, 0, 30, 0, 0, 0]),
    ('.', [0, 0, 0, 0, 0, 0, 4, 0]),
    ('/', [2, 2, 4, 4, 8, 8, 16, 16]),
    ('0', [0, 12, 18, 22, 26, 18, 12, 0]),
    ('1', [0, 4, 12, 4, 4, 4, 14, 0]),
    ('2', [0, 12, 18, 2, 12, 16, 30, 0]),
    ('3', [0, 12, 18, 4, 2, 18, 12, 0]),
    ('4', [0, 16, 20, 20, 30, 4, 4, 0]),
    ('5', [0, 30, 16, 28, 2, 2, 28, 0]),
    ('6', [0, 12, 16, 28, 18, 18, 12, 0]),
    ('7', [0, 30, 18, 2, 4, 8, 8, 0]),
    ('8', [0, 12, 18, 12, 18, 18, 12, 0]),
    ('9', [0, 12, 18, 18, 14, 2, 12, 0]),
    (':', [0, 0, 0, 4, 0, 0, 4, 0]),
    (';', [0, 0, 0, 4, 0, 4, 4, 8]),
    ('<', [0, 2, 4, 8, 8, 4, 2, 0]),
    ('=', [0, 0, 0, 30, 0, 30, 0, 0]),
    ('>', [0, 8, 4, 2, 2, 4, 8, 0]),
    ('?', [12, 18, 2, 4, 8, 0, 8, 0]),
    ('@', [0, 12, 18, 22, 22, 16, 14, 0]),
    ('A', [0, 12, 18, 18, 30, 18, 18, 0]),
    ('B', [0, 28, 18, 28, 18, 18, 28, 0]),
    ('C', [0, 14, 16, 16, 16, 16, 14, 0]),
    ('D', [0, 28, 18, 18, 18, 18, 28, 0]),
    ('E', [0, 14, 16, 28, 16, 16, 14, 0]),
    ('F', [0, 14, 16, 16, 28, 16, 16, 0]),
    ('G', [0, 14, 16, 22, 18, 18, 14, 0]),
    ('H', [0, 18, 18, 30, 18, 18, 18, 0]),
    ('I', [0, 14, 4, 4, 4, 4, 14, 0]),
    ('J', [0, 14, 4, 4, 4, 4, 24, 0]),
    ('K', [0, 18, 18, 28, 18, 18, 18, 0]),
    ('L', [0, 16, 16, 16, 16, 16, 14, 0]),
    ('M', [0, 18, 30, 30, 18, 18, 18, 0]),
    ('N', [0, 18, 26, 26, 22, 22, 18, 0]),
    ('O', [0, 12, 18, 18, 18, 18, 12, 0]),
    ('P', [0, 28, 18, 18, 28, 16, 16, 0]),
    ('Q', [0, 12, 18, 18, 18, 18, 12, 6]),
    ('R', [0, 28, 18, 18, 28, 18, 18, 0]),
    ('S', [0, 14, 16, 12, 2, 2, 28, 0]),
    ('T', [0, 31, 4, 4, 4, 4, 4, 0]),
    ('U', [0, 18, 18, 18, 18, 18, 14, 0]),
    ('V', [0, 18, 18, 18, 18, 12, 12, 0]),
    ('W', [0, 18, 18, 18, 30, 30, 18, 0]),
    ('X', [0, 18, 18, 12, 12, 18, 18, 0]),
    ('Y', [0, 18, 18, 18, 14, 2, 28, 0]),
    ('Z', [0, 30, 2, 4, 8, 16, 30, 0]),
    ('[', [14, 8, 8, 8, 8, 8, 8, 14]),
    ('\\', [16, 16, 8, 8, 4, 4, 2, 2]),
    (']', [14, 2, 2, 2, 2, 2, 2, 14]),
    ('^', [0, 4, 10, 17, 0, 0, 0, 0]),
    ('_', [0, 0, 0, 0, 0, 0, 0, 30]),
    ('`', [8, 4, 0, 0, 0, 0, 0, 0]),
    ('a', [0, 0, 12, 2, 14, 18, 14, 0]),
    ('b', [16, 16, 28, 18, 18, 18, 28, 0]),
    ('c', [0, 0, 14, 16, 16, 16, 14, 0]),
    ('d', [2, 2, 14, 18, 18, 18, 14, 0]),
    ('e', [0, 0, 14, 18, 30, 16, 14, 0]),
    ('f', [6, 8, 8, 28, 8, 8, 8, 0]),
    ('g', [0, 0, 14, 18, 18, 12, 2, 28]),
    ('h', [16, 16, 28, 18, 18, 18, 18, 0]),
    ('i', [0, 4, 0, 12, 4, 4, 6, 0]),
    ('j', [0, 4, 0, 4, 4, 4, 4, 24]),
    ('k', [16, 16, 18, 20, 24, 20, 18, 0]),
    ('l', [8, 8, 8, 8, 8, 8, 6, 0]),
    ('m', [0, 0, 18, 30, 30, 18, 18, 0]),
    ('n', [0, 0, 28, 18, 18, 18, 18, 0]),
    ('o', [0, 0, 12, 18, 18, 18, 12, 0]),
    ('p', [0, 0, 28, 18, 18, 28, 16, 16]),
    ('q', [0, 0, 14, 18, 18, 14, 2, 2]),
    ('r', [0, 0, 14, 18, 16, 16, 16, 0]),
    ('s', [0, 0, 14, 16, 12, 2, 28, 0]),
    ('t', [8, 8, 28, 8, 8, 8, 6, 0]),
    ('u', [0, 0, 18, 18, 18, 18, 14, 0]),
    ('v', [0, 0, 18, 18, 18, 12, 12, 0]),
    ('w', [0, 0, 18, 18, 30, 30, 18, 0]),
    ('x', [0, 0, 18, 12, 12, 18, 18, 0]),
    ('y', [0, 0, 18, 18, 18, 14, 2, 28]),
    ('z', [0, 0, 30, 2, 4, 8, 30, 0]),
    ('{', [6, 8, 8, 24, 24, 8, 8, 6]),
    ('|', [4, 4, 4, 4, 4, 4, 4, 4]),
    ('}', [24, 4, 4, 6, 6, 4, 4, 24]),
    ('~', [0, 0, 0, 9, 22, 0, 0, 0]),
    ('—', [0, 0, 0, 0, 31, 31, 0, 0]),
    ('•', [0, 0, 4, 14, 14, 4, 0, 0]),
    ('←', [0, 4, 8, 31, 8, 4, 0, 0]),
    ('→', [0, 4, 2, 31, 2, 4, 0, 0]),
    ('∀', [17, 17, 17, 31, 10, 10, 4, 0]),
    ('∅', [0, 2, 14, 22, 26, 28, 8, 0]),
    ('∵', [0, 10, 0, 0, 4, 0, 0, 0]),
    ('≺', [0, 2, 4, 8, 4, 2, 0, 0]),
    ('≻', [0, 8, 4, 2, 4, 8, 0, 0]),
    ('⊘', [14, 17, 19, 21, 25, 17, 14, 0]),
    ('─', [0, 0, 0, 31, 0, 0, 0, 0]),
    ('▰', [31, 31, 31, 31, 31, 31, 31, 31]),
];

/// A visible box for characters the font lacks.
const REPLACEMENT: [u8; 8] = [31, 17, 21, 17, 21, 17, 31, 0];

/// The rows of `character`'s glyph.
pub fn glyph(character: char) -> &'static [u8; 8] {
    GLYPHS
        .binary_search_by_key(&character, |(key, _)| *key)
        .map_or(&REPLACEMENT, |index| &GLYPHS[index].1)
}

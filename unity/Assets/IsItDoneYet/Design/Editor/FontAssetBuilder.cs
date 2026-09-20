using System.Collections.Generic;
using System.IO;
using System.Text;
using TMPro;
using UnityEditor;
using UnityEngine;
using UnityEngine.TextCore.LowLevel;

namespace IsItDoneYet.Design.Editor
{
    /// <summary>
    /// Bakes the two licensed TTFs into TextMeshPro SDF atlases.
    ///
    /// Static atlases, not dynamic. A dynamic atlas renders a glyph the first time it is asked
    /// for, which means the first frame that shows a new character does font rasterisation on
    /// the main thread -- on a mobile chip that is a visible hitch, and it lands exactly when a
    /// toast appears, which is the worst possible moment. A static atlas is built here, once,
    /// and the device only ever samples a texture.
    ///
    /// The character set is explicit and includes the four coach glyphs. A missing glyph in TMP
    /// is not an error, it is a blank -- so the run reports what it could not find rather than
    /// leaving somebody to notice that the "unsure" toast has no question mark.
    /// </summary>
    public static class FontAssetBuilder
    {
        const string FontDir = "Assets/IsItDoneYet/Design/Fonts";

        /// <summary>
        /// Latin-1 printable, the punctuation the copy uses, and the four status glyphs.
        ///
        /// The interesting ones are at the end. `×` appears in every ingredient count in the
        /// reference ("Tomato ×3"), `·` separates every metadata line, and the check, cross and
        /// warning marks are the coach's verdict glyphs -- drawn as text rather than as sprites
        /// so they inherit the label's outline and stay legible over passthrough for free.
        /// </summary>
        public static string CharacterSet()
        {
            var builder = new StringBuilder();
            for (var c = 0x20; c <= 0x7E; c++) builder.Append((char)c);
            for (var c = 0xA0; c <= 0xFF; c++) builder.Append((char)c);
            // Latin-1 plus the punctuation the copy actually uses. `×` is in every ingredient
            // count in the reference ("Tomato ×3") and `·` separates every metadata line.
            //
            // The coach's status marks are deliberately NOT here. Neither licensed face
            // contains a check or a cross -- verified, not assumed: the first build of this
            // tool reported them missing from both. They are drawn as geometry instead; see
            // StatusGlyph. A glyph that silently renders as a blank box is worse than one the
            // design never asked the font for.
            builder.Append("×·–—‘’°");
            return builder.ToString();
        }

        [MenuItem("IsItDoneYet/Design/Build Font Assets")]
        public static void BuildMenu() => Build();

        /// <summary>Entry point for batchmode.</summary>
        public static void BuildBatch()
        {
            if (!Build()) EditorApplication.Exit(1);
        }

        public static bool Build()
        {
            var ok = true;
            // 90pt sampling into 1024x1024. Display type is set very large -- the title is
            // 132px in the reference -- and an SDF sampled too small goes soft exactly where
            // the design is loudest. 1024 holds this character set at 90pt with room spare;
            // 512 overflows into a second atlas page and doubles the draw calls for text.
            ok &= BuildOne("Ranchers-Regular.ttf", "Ranchers-SDF", 90, 1024);
            ok &= BuildOne("HankenGrotesk[wght].ttf", "HankenGrotesk-SDF", 90, 1024);
            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();
            return ok;
        }

        static bool BuildOne(string ttfName, string assetName, int samplingPointSize, int atlasSize)
        {
            var ttfPath = $"{FontDir}/{ttfName}";
            var source = AssetDatabase.LoadAssetAtPath<Font>(ttfPath);
            if (source == null)
            {
                Debug.LogError($"[Design] no font at {ttfPath}");
                return false;
            }

            var outputPath = $"{FontDir}/{assetName}.asset";

            // Built dynamic, filled, then frozen. TMP has no "create static with these
            // characters" call: the supported route is to create a dynamic asset, add the
            // glyphs, and switch the population mode, which bakes what was added and stops it
            // rasterising anything new at runtime.
            var fontAsset = TMP_FontAsset.CreateFontAsset(
                source,
                samplingPointSize,
                9,
                GlyphRenderMode.SDFAA,
                atlasSize,
                atlasSize,
                AtlasPopulationMode.Dynamic,
                enableMultiAtlasSupport: false);

            if (fontAsset == null)
            {
                Debug.LogError($"[Design] TMP could not create a font asset from {ttfName}");
                return false;
            }

            fontAsset.name = assetName;

            var characters = CharacterSet();
            if (!fontAsset.TryAddCharacters(characters, out var missing))
            {
                // Not fatal. A face legitimately does not contain every character asked for --
                // Ranchers is a display face with no arrows -- and the honest response is to
                // say which ones and carry on, not to fail the build.
                Debug.LogWarning($"[Design] {assetName}: {missing.Length} character(s) not in the face: {missing}");
            }

            // Freeze AFTER the glyphs are in, and do nothing else.
            //
            // The obvious-looking "clear, then re-add" is wrong in a way that produces a
            // working-looking asset with an empty character table: once the mode is Static, TMP
            // will not rasterise, so the re-add silently adds nothing and the clear has already
            // thrown away what was there. The first run of this tool produced exactly that --
            // "0 glyphs" -- and a font asset with no glyphs renders as nothing at all.
            fontAsset.atlasPopulationMode = AtlasPopulationMode.Static;

            var existing = AssetDatabase.LoadAssetAtPath<TMP_FontAsset>(outputPath);
            if (existing != null) AssetDatabase.DeleteAsset(outputPath);

            AssetDatabase.CreateAsset(fontAsset, outputPath);

            // The atlas texture and the material are separate objects. Left loose they are not
            // saved with the asset, and the font works in the Editor and renders as solid
            // blocks in a build -- the classic "it worked on my machine" TMP failure.
            if (fontAsset.atlasTextures != null)
            {
                for (var i = 0; i < fontAsset.atlasTextures.Length; i++)
                {
                    var texture = fontAsset.atlasTextures[i];
                    if (texture == null) continue;
                    texture.name = $"{assetName} Atlas {i}";
                    AssetDatabase.AddObjectToAsset(texture, fontAsset);
                }
            }
            if (fontAsset.material != null)
            {
                fontAsset.material.name = $"{assetName} Material";
                AssetDatabase.AddObjectToAsset(fontAsset.material, fontAsset);
            }

            EditorUtility.SetDirty(fontAsset);
            AssetDatabase.SaveAssets();

            var glyphCount = fontAsset.characterTable != null ? fontAsset.characterTable.Count : 0;
            Debug.Log($"[Design] {assetName}: {glyphCount} glyphs at {samplingPointSize}pt in {atlasSize}x{atlasSize}");
            return true;
        }

        /// <summary>
        /// Fallbacks, so a character missing from the display face is drawn by the body face
        /// rather than as a blank box.
        ///
        /// Ranchers is an all-caps display face with a small repertoire; Hanken Grotesk covers
        /// everything this app writes. Chaining them means an unexpected character degrades to
        /// the wrong typeface instead of to nothing, which is the right way round.
        /// </summary>
        [MenuItem("IsItDoneYet/Design/Link Font Fallbacks")]
        public static void LinkFallbacks()
        {
            var display = AssetDatabase.LoadAssetAtPath<TMP_FontAsset>($"{FontDir}/Ranchers-SDF.asset");
            var body = AssetDatabase.LoadAssetAtPath<TMP_FontAsset>($"{FontDir}/HankenGrotesk-SDF.asset");
            if (display == null || body == null)
            {
                Debug.LogError("[Design] build the SDF assets first");
                return;
            }

            display.fallbackFontAssetTable ??= new List<TMP_FontAsset>();
            if (!display.fallbackFontAssetTable.Contains(body)) display.fallbackFontAssetTable.Add(body);

            EditorUtility.SetDirty(display);
            AssetDatabase.SaveAssets();
            Debug.Log("[Design] Ranchers now falls back to Hanken Grotesk");
        }

        /// <summary>One call for batchmode: build both, link fallbacks, import tokens.</summary>
        public static void BuildAllBatch()
        {
            if (!Build()) { EditorApplication.Exit(1); return; }
            LinkFallbacks();
            var tokens = DesignTokenImporter.Import();
            if (tokens == null) { EditorApplication.Exit(1); return; }
            Debug.Log("[Design] fonts + tokens ready");
        }
    }
}

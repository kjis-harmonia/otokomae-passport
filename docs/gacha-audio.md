# ガチャの音声のつなぎ

対象はStagingの深海ガチャ。映像の内容・順番・タイミング、景品・回数制限・DBは変更しない。

## 原因と変更

元の動画3本の音声は、intro約−16.2 dBFS、wait約−19.6 dBFS、open約−22.5 dBFS（全体のRMS）。とくにopen冒頭100msは約−53.5 dBFS。元の画面はwaitとopenを同時に鳴らし、0.6秒後にwaitを音量変更なしで停止していた。

- 映像のvideoは常にmuted。動画のendedイベントやloopのデコーダー再始動に音の連続性を依存させない。
- 音声は1つのWeb Audioクロックでサンプル単位に予約。intro終端の1.2秒前からwaitを重ね、タップ後はopenが実際にplayingになってから2秒で交差させる。
- waitはロスレスPCM。末尾と先頭を0.65秒重ね、次のループの最初のサンプルに連続する位置で切り出す。映像の周期とは独立した環境音のループ。
- 元の効果音を残して、左右連動の緩やかな音量補正とピーク制限を実施。openの終端は1.2秒で余韻を下げる。
- 閉じる／画面を離れる際は80msで音を下げ、未来に予約済みのループも停止する。再開時に二重再生しない。
- 音源の取得・デコードも準備完了の条件に含める。取得失敗時に未準備の音を無理にストリーミングせず、「読み込み直す」を表示する。

新規音源は合計約1.67 MB。intro／waitのMP4とポスターは保持する。

開放のMP4だけは元がH.264 High 4:4:4 Predictive／yuv444pだったため、他の2本と同じHigh／yuv420pへ互換エンコードした。720×1280・24fps・全396フレーム・尺は維持。音声は再圧縮せずコピーし、デコードした音声793600フレームのSHA-256が元と完全一致することを確認。全フレーム比較のSSIMは0.992718（0〜1、1が同一）。再圧縮なので画素が完全同一という意味ではない。実iPhoneの再生確認は別途必要。

## 再生成

Python＋numpy＋FFmpegが必要。プロジェクトのnpm依存は追加しない。

```text
python scripts/master-gacha-audio.py --ffmpeg /path/to/ffmpeg
```

入力はpublic/gacha/gacha-{intro,wait,open}.mp4。出力は同じフォルダのgacha-intro-audio.m4a、gacha-wait-audio.wav、gacha-open-audio.m4a。元MP4のSHA-256が変わらないことをスクリプトで確認する。FFmpegのバージョン差でエンコード結果のバイト列は変わり得る。

## 検証

- scripts/gacha-soundtrack.test.mjs：等電力クロスフェードの包絡、先行予約、待機ループ、開放、途中終了、再開、videoのミュートを検査。
- ChromiumのOfflineAudioContextで、タップ位置0.02／1.5／4／9秒の4ケースをレンダリング。20ms以上かつ−65 dBFS未満の無音区間は0（始端・終端の意図したフェードは除外）。ループ境界のサンプル段差は約−57.6 dBFS。
- 9秒待ってタップした比較：元コードの0.6秒後停止の直前・直後各50msは約20.3 dBの差。新しい2秒フェード終端では約0.56 dB。この数値は特定の音源・時刻の比較で、全タップ位置で音楽の変化が0.56 dB以下という保証ではない。
- 調整済み54.625秒の出力をFFmpeg ebur128で検査：−21.9 LUFS、LRA 2.8 LU、true peak約−7.4 dBFS。
- ローカルの実画面で開始→タップ待ち→開放→結果→閉じる→再開を確認。型・lint・ビルドが成功。動画形式の回帰チェック追加後、全88テストが成功。

波形検査とブラウザー再生は、人の耳でのABX試聴や実iPhoneのオーディオ出力試験の代わりではない。「すべての人が継ぎ目を知覚できない」とは断言しない。Stagingの同じ音量設定で、iPhoneのスピーカー／イヤホンで最後の試聴を行う。

参考：[Web Audioのループ](https://developer.mozilla.org/en-US/docs/Web/API/AudioBufferSourceNode/loop)、[音量カーブの予約](https://developer.mozilla.org/en-US/docs/Web/API/AudioParam/setValueCurveAtTime)、[FFmpeg Filters](https://ffmpeg.org/ffmpeg-filters.html)。

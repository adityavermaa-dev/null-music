import { Innertube } from "youtubei.js";

async function test() {
    try {
        const yt = await Innertube.create({ lang: "en", location: "IN", retrieve_player: true });
        console.log("Fetching info...");
        const info = await yt.music.getInfo("M6DyhuxoNw8");

        console.log("Formats available:", info.streaming_data?.adaptive_formats?.length);

        const format = info.chooseFormat({ type: 'audio', quality: 'best' });

        let url = format?.url;
        if (!url && format?.decipher) {
            url = await format.decipher(yt.session.player);
        }

        console.log("Stream URL:", typeof url, url ? url.substring(0, 50) + "..." : "null");
    } catch (e) {
        console.error("FULL ERROR:", e.stack);
    }
}

test().catch(e => console.error("Global error:", e));

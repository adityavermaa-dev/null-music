import { Innertube, Platform } from "youtubei.js";

Platform.shim.eval = async (data, env) => {
    const properties = [];
    if (env.n) { properties.push(`n: exportedVars.nFunction("${env.n}")`) }
    if (env.sig) { properties.push(`sig: exportedVars.sigFunction("${env.sig}")`) }
    const code = `${data.output}\nreturn { ${properties.join(', ')} }`;
    return new Function(code)();
}

async function test() {
    try {
        const yt = await Innertube.create({ lang: "en", location: "IN", retrieve_player: true });
        console.log("Fetching info...");
        const info = await yt.music.getInfo("M6DyhuxoNw8");

        console.log("Formats available:", info.streaming_data?.adaptive_formats?.length);

        const format = info.chooseFormat({ type: 'audio', quality: 'best' });

        let url = format?.url;
        if (!url && format?.decipher) {
            url = format.decipher(yt.session.player);
        }

        console.log("Stream URL:", typeof url, url ? String(url).substring(0, 50) + "..." : "null");
    } catch (e) {
        console.error("FULL ERROR:", e.stack);
    }
}

test().catch(e => console.error("Global error:", e));

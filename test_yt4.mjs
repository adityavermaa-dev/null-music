import { Innertube, Platform } from "youtubei.js";

Platform.shim.eval = async (data, env) => {
    const properties = [];
    if (env.n) { properties.push(`n: exportedVars.nFunction("${env.n}")`) }
    if (env.sig) { properties.push(`sig: exportedVars.sigFunction("${env.sig}")`) }
    const code = `${data.output}\nreturn { ${properties.join(', ')} }`;

    try {
        return new Function(code)();
    } catch (e) {
        console.error("Eval error:", e.message);
        console.log("Code sample:", code.substring(code.length - 200));
        throw e;
    }
}

async function test() {
    try {
        const yt = await Innertube.create({ lang: "en", location: "IN", retrieve_player: true });
        console.log("Fetching info...");
        const info = await yt.music.getInfo("M6DyhuxoNw8");
        const format = info.chooseFormat({ type: 'audio', quality: 'best' });

        let url = format?.url;
        if (!url && format?.decipher) {
            console.log("Awaiting decipher...");
            url = await format.decipher(yt.session.player);
        }

        console.log("Stream URL:", url);
    } catch (e) {
        console.error("FULL ERROR:", e.stack);
    }
}

test().catch(e => console.error(e));

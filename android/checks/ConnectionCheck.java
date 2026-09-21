import kr.ac.roi.viewer.ConnectionPolicy;

public class ConnectionCheck {
    public static void main(String[] args) {
        String secret = "abcdefghijklmnop0123456789_-ABCD";
        var pc = ConnectionPolicy.parseLink(" https://192.168.0.8:8443/#" + secret + " ");
        if (!ConnectionPolicy.sameOrigin(pc, "https://192.168.0.8:8443/app.js")) throw new AssertionError();
        for (String other : new String[]{"https://192.168.0.8/", "http://192.168.0.8:8443/",
                "https://192.168.0.8.evil.example:8443/", "https://192.168.0.8:8443@evil.example/",
                "file:///private.json", "content://provider/file", "javascript:alert(1)", "null", null})
            if (ConnectionPolicy.sameOrigin(pc, other)) throw new AssertionError("Untrusted origin accepted");
        var standard = ConnectionPolicy.parseLink("HTTPS://PC.EXAMPLE:443/#" + secret);
        if (!ConnectionPolicy.sameOrigin(standard, "https://pc.example/")) throw new AssertionError();
        for (String bad : new String[]{"http://pc/#" + secret, "https://pc/", "https://pc/#short",
                "https://pc/path#" + secret, "https://pc/?token=" + secret, "https://user@pc/#" + secret,
                "https://pc:0/#" + secret, "https://pc:99999/#" + secret, "https://pc/#%61" + secret}) {
            try { ConnectionPolicy.parseLink(bad); throw new AssertionError("Bad link accepted"); }
            catch (IllegalArgumentException expected) {
                if (expected.getMessage().contains(secret)) throw new AssertionError("Token leaked");
            }
        }
        System.out.println("PASS: HTTPS link, exact origin, port, token validation and secret-free errors");
    }
}

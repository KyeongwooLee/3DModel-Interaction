package kr.ac.roi.viewer;

import java.net.URI;
import java.util.Locale;

/** One policy for navigation, camera permission and native messages. */
public final class ConnectionPolicy {
    private ConnectionPolicy() {}

    public static URI parseLink(String input) {
        try {
            if (input == null || input.length() > 2048) throw new IllegalArgumentException();
            URI uri = new URI(input.trim());
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null
                    || uri.getRawUserInfo() != null || uri.getRawQuery() != null
                    || !(uri.getRawPath().isEmpty() || uri.getRawPath().equals("/"))
                    || uri.getPort() == 0 || uri.getPort() > 65535
                    || uri.getRawFragment() == null || !uri.getRawFragment().matches("[A-Za-z0-9_-]{16,128}"))
                throw new IllegalArgumentException();
            return new URI("https", null, uri.getHost().toLowerCase(Locale.ROOT),
                    uri.getPort() == 443 ? -1 : uri.getPort(), "/", null, uri.getRawFragment());
        } catch (Exception error) {
            // Never include the pasted URL (which contains a secret token) in errors.
            throw new IllegalArgumentException("PC가 출력한 https://주소:포트/#연결토큰 전체를 붙여넣어 주세요.");
        }
    }

    public static String origin(URI uri) { return "https://" + uri.getRawAuthority(); }

    public static boolean sameOrigin(URI selected, String candidate) {
        if (selected == null || candidate == null) return false;
        try {
            URI uri = new URI(candidate);
            return "https".equalsIgnoreCase(uri.getScheme()) && uri.getRawUserInfo() == null
                    && selected.getHost().equalsIgnoreCase(uri.getHost())
                    && port(selected) == port(uri);
        } catch (Exception error) { return false; }
    }

    private static int port(URI uri) { return uri.getPort() < 0 ? 443 : uri.getPort(); }
}

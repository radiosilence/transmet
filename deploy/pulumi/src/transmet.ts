import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { IMAGE } from "./versions.ts";

/**
 * A hostname the deployment should publish, and the workload answering it.
 * `service` is the name prefix: the Service is `<prefix>-service`.
 */
export type Route = { service: string; hostname: string };

/** The OAuth client the provider must register for this deployment. */
export type OidcClient = { id: string; name: string; redirectUri: string };

export type Deployed = { routes: Route[]; oidc?: OidcClient };

/** Egress to these would reach the house or the cluster rather than the issuer. */
const PRIVATE = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"];

/**
 * The reader and every page of the comic, in one private image.
 *
 * The pages are baked in rather than mounted, so the pod has no node to be
 * pinned to and nothing to fetch at runtime. That makes the image the thing to
 * protect: it is pulled with a registry credential, and the site itself needs a
 * sign-in, through the OIDC provider when `oidc` is given and by password
 * always.
 */
export function createTransmet(
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  opts: {
    hostname: string;
    /** The one password the site asks for. Rotating it signs every device out. */
    password: pulumi.Input<string>;
    /** Read access to ghcr.io, since the image holds the comic itself. */
    registry: { username: pulumi.Input<string>; token: pulumi.Input<string> };
    /**
     * Single sign-on. The provider's own allowlist decides who gets in; the
     * password stays as the way in when the provider is down.
     */
    oidc?: {
      issuer: string;
      clientId: string;
      clientSecret: pulumi.Input<string>;
      /**
       * The provider's public API inside the cluster, for the token exchange.
       * Needed when the pod shares a node with the ingress: Cilium matches no
       * CIDR rule against the node's own addresses, so a call out to the
       * issuer's public hostname is dropped.
       */
      backchannel?: { url: string; podLabels: Record<string, string>; port: number };
    };
    limits?: { cpu: string; memory: string };
    requests?: { cpu: string; memory: string };
    nodeSelector?: Record<string, string>;
  },
) {
  const options = { provider };
  const labels = { app: "transmet" };

  const secret = new k8s.core.v1.Secret(
    "transmet",
    {
      metadata: { name: "transmet", namespace },
      stringData: {
        password: opts.password,
        ...(opts.oidc && { "oidc-client-secret": opts.oidc.clientSecret }),
      },
    },
    options,
  );

  const pull = new k8s.core.v1.Secret(
    "transmet-pull",
    {
      metadata: { name: "transmet-pull", namespace },
      type: "kubernetes.io/dockerconfigjson",
      stringData: {
        ".dockerconfigjson": pulumi
          .all([opts.registry.username, opts.registry.token])
          .apply(([username, token]) =>
            JSON.stringify({
              auths: {
                "ghcr.io": {
                  auth: Buffer.from(`${username}:${token}`).toString("base64"),
                },
              },
            }),
          ),
      },
    },
    options,
  );

  new k8s.apps.v1.Deployment(
    "transmet",
    {
      metadata: { name: "transmet", namespace, labels },
      spec: {
        replicas: 1,
        selector: { matchLabels: labels },
        template: {
          metadata: {
            labels,
            // Restarts the pod when a secret changes, which a Secret
            // referenced by env would otherwise leave stale until it next rolls.
            annotations: {
              "transmet.radiosilence.dev/secrets": pulumi
                .all([opts.password, opts.oidc?.clientSecret ?? ""])
                .apply((values) => hash(values.join("\0"))),
            },
          },
          spec: {
            imagePullSecrets: [{ name: pull.metadata.name }],
            nodeSelector: opts.nodeSelector,
            automountServiceAccountToken: false,
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 65532,
              runAsGroup: 65532,
              seccompProfile: { type: "RuntimeDefault" },
            },
            containers: [
              {
                name: "transmet",
                image: IMAGE,
                ports: [{ name: "http", containerPort: 3000 }],
                env: [
                  {
                    name: "TRANSMET_PASSWORD",
                    valueFrom: { secretKeyRef: { name: secret.metadata.name, key: "password" } },
                  },
                  ...(opts.oidc
                    ? [
                        { name: "PUBLIC_URL", value: `https://${opts.hostname}` },
                        { name: "OIDC_ISSUER", value: opts.oidc.issuer },
                        { name: "OIDC_CLIENT_ID", value: opts.oidc.clientId },
                        ...(opts.oidc.backchannel
                          ? [{ name: "OIDC_TOKEN_URL", value: `${opts.oidc.backchannel.url}/oauth2/token` }]
                          : []),
                        {
                          name: "OIDC_CLIENT_SECRET",
                          valueFrom: {
                            secretKeyRef: { name: secret.metadata.name, key: "oidc-client-secret" },
                          },
                        },
                      ]
                    : []),
                ],
                readinessProbe: { httpGet: { path: "/_health", port: "http" }, periodSeconds: 10 },
                livenessProbe: {
                  httpGet: { path: "/_health", port: "http" },
                  initialDelaySeconds: 5,
                  periodSeconds: 30,
                },
                resources: {
                  limits: opts.limits ?? { cpu: "500m", memory: "256Mi" },
                  requests: opts.requests,
                },
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ["ALL"] },
                },
              },
            ],
          },
        },
      },
    },
    options,
  );

  // Named for what the ingress derives from the route prefix.
  new k8s.core.v1.Service(
    "transmet-service",
    {
      metadata: { name: "transmet-service", namespace },
      spec: { selector: labels, ports: [{ port: 80, targetPort: 3000 }] },
    },
    options,
  );

  // It serves files, so without sign-on it reaches nothing. With it, the only
  // call out is to the issuer's token endpoint: the provider's pods when a
  // backchannel is given, otherwise anywhere public. No ingress
  // rule: Traefik reaches it, and an ingress policy that also drops the
  // kubelet's probes gets the pod killed for failing readiness.
  new k8s.networking.v1.NetworkPolicy(
    "transmet-netpol",
    {
      metadata: { name: "transmet", namespace },
      spec: {
        podSelector: { matchLabels: labels },
        policyTypes: ["Egress"],
        egress: opts.oidc
          ? [
              {
                to: [
                  {
                    namespaceSelector: {
                      matchLabels: { "kubernetes.io/metadata.name": "kube-system" },
                    },
                  },
                ],
                ports: [
                  { protocol: "UDP", port: 53 },
                  { protocol: "TCP", port: 53 },
                ],
              },
              opts.oidc.backchannel
                ? {
                    to: [{ podSelector: { matchLabels: opts.oidc.backchannel.podLabels } }],
                    ports: [{ protocol: "TCP", port: opts.oidc.backchannel.port }],
                  }
                : {
                    to: [{ ipBlock: { cidr: "0.0.0.0/0", except: PRIVATE } }],
                    ports: [{ protocol: "TCP", port: 443 }],
                  },
            ]
          : [],
      },
    },
    options,
  );

  return {
    routes: [{ service: "transmet", hostname: opts.hostname }],
    oidc: opts.oidc && {
      id: opts.oidc.clientId,
      name: "Transmet",
      redirectUri: `https://${opts.hostname}/auth/callback`,
    },
  } satisfies Deployed;
}

function hash(value: string) {
  let h = 0x811c9dc5;
  for (const c of value) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193);
  return (h >>> 0).toString(16);
}

import UIKit

/// First-run screen: enter the server URL.
final class ServerSetupViewController: UIViewController {
    var onConnect: ((URL) -> Void)?

    private let titleLabel = UILabel()
    private let subtitleLabel = UILabel()
    private let field = UITextField()
    private let button = UIButton(type: .system)
    private let errorLabel = UILabel()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        buildUI()
    }

    private func buildUI() {
        titleLabel.text = "Connect to your server"
        titleLabel.font = .systemFont(ofSize: 26, weight: .bold)
        titleLabel.textColor = .white
        titleLabel.textAlignment = .center

        subtitleLabel.text = "Enter the URL of your hokago instance — e.g. http://192.168.1.20:3000"
        subtitleLabel.font = .systemFont(ofSize: 14)
        subtitleLabel.textColor = UIColor(white: 0.6, alpha: 1)
        subtitleLabel.textAlignment = .center
        subtitleLabel.numberOfLines = 0

        field.placeholder = "https://hokago.example.com"
        field.keyboardType = .URL
        field.autocapitalizationType = .none
        field.autocorrectionType = .no
        field.textContentType = .URL
        field.borderStyle = .roundedRect
        field.backgroundColor = UIColor(white: 0.13, alpha: 1)
        field.textColor = .white
        field.returnKeyType = .go

        button.setTitle("Connect", for: .normal)
        button.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
        button.addTarget(self, action: #selector(connectTapped), for: .touchUpInside)

        errorLabel.textColor = .systemRed
        errorLabel.font = .systemFont(ofSize: 13)
        errorLabel.textAlignment = .center
        errorLabel.numberOfLines = 0

        for v in [titleLabel, subtitleLabel, field, button, errorLabel] {
            v.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(v)
        }

        NSLayoutConstraint.activate([
            titleLabel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            titleLabel.topAnchor.constraint(equalTo: view.centerYAnchor, constant: -150),
            titleLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 32),
            titleLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -32),

            subtitleLabel.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 12),
            subtitleLabel.leadingAnchor.constraint(equalTo: titleLabel.leadingAnchor),
            subtitleLabel.trailingAnchor.constraint(equalTo: titleLabel.trailingAnchor),

            field.topAnchor.constraint(equalTo: subtitleLabel.bottomAnchor, constant: 28),
            field.leadingAnchor.constraint(equalTo: titleLabel.leadingAnchor),
            field.trailingAnchor.constraint(equalTo: titleLabel.trailingAnchor),
            field.heightAnchor.constraint(equalToConstant: 48),

            button.topAnchor.constraint(equalTo: field.bottomAnchor, constant: 16),
            button.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            button.widthAnchor.constraint(greaterThanOrEqualToConstant: 160),
            button.heightAnchor.constraint(equalToConstant: 44),

            errorLabel.topAnchor.constraint(equalTo: button.bottomAnchor, constant: 12),
            errorLabel.leadingAnchor.constraint(equalTo: titleLabel.leadingAnchor),
            errorLabel.trailingAnchor.constraint(equalTo: titleLabel.trailingAnchor),
        ])
    }

    @objc private func connectTapped() {
        guard var text = field.text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else {
            errorLabel.text = "Enter a server URL."
            return
        }
        if !text.lowercased().hasPrefix("http://"), !text.lowercased().hasPrefix("https://") {
            text = "http://" + text
        }
        guard let url = URL(string: text) else {
            errorLabel.text = "That doesn't look like a valid URL."
            return
        }
        onConnect?(url)
    }
}